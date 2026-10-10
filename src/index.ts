import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { RunRecorder, summarise } from "./telemetry/report";
import { UsageLedger } from "./telemetry/usage";
import { addUsage, type TokenUsage } from "./telemetry/types";
import { PhaseTimer } from "./telemetry/timing";
import { readUsage } from "./telemetry/adapters/opencode";
import { checkTopology } from "./coordinator/topology";
import { parsePlan, MalformedPlan } from "./coordinator/parse";
import { validatePlan } from "./validate/plan";
import type { Plan } from "./contracts/types";
import { PLANNER_AGENT_ID, withPlannerAgent } from "./coordinator/agent";
import { dispatch } from "./dispatch";
import { WorkerSessions, type SessionSpawner } from "./dispatch/spawn";
import { RunObserver } from "./dispatch/observe";
import { BudgetEnforcer } from "./dispatch/hooks";
import type { ModelConfig } from "./dispatch/routing";
import { aggregate } from "./aggregate";
import { snapshotAnchors } from "./review/anchors";
import { PLAN_SCHEMA_JSON } from "./contracts/schema";
import { SqliteTokenSource } from "./telemetry/adapters/session-db";

/**
 * The opencode plugin entry point.
 *
 * Until this file existed, Cubicore could be measured only against what it
 * competes with — never against itself. This is what makes the `orchestrated`
 * arm of the benchmark runnable.
 *
 * Verified against `@opencode-ai/plugin@1.18.35`, which corrected two earlier
 * assumptions:
 *   - `tool.execute.before` exposes only `{ args }` — there is **no veto
 *     field**, so it cannot stop a call. The tool-call cap is advisory.
 *   - `session.abort` **does** exist, so a wall-clock overrun can be a real
 *     stop rather than Cubicore merely losing interest.
 */

const STRONG_MODEL = process.env.CUBICORE_STRONG_MODEL ?? "opencode/big-pickle";
const WORKER_MODEL = process.env.CUBICORE_WORKER_MODEL ?? "opencode/space-bunny-free";

interface ClientLike {
  session: {
    create(args: { query?: { directory?: string } }): Promise<{ data?: { id?: string } | null }>;
    prompt(args: {
      body: {
        agent?: string;
        model?: { providerID: string; modelID: string };
        parts: Array<{ type: "text"; text: string }>;
      };
      path: { id: string };
      query?: { directory?: string };
    }): Promise<unknown>;
    diff(args: { path: { id: string }; query?: { directory?: string } }): Promise<{
      data?: Array<{ file?: string }> | null;
    }>;
    abort(args: { path: { id: string }; query?: { directory?: string } }): Promise<unknown>;
  };
}

function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash < 0) return { providerID: "opencode", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function clientSpawner(client: ClientLike, directory: string): SessionSpawner {
  return {
    async create() {
      const result = await client.session.create({ query: { directory } });
      const id = result.data?.id;
      if (!id) throw new Error("opencode did not return a session id");
      return { sessionId: id };
    },

    async prompt(sessionId, input) {
      await client.session.prompt({
        path: { id: sessionId },
        query: { directory },
        body: {
          agent: input.agent,
          model: input.model ? splitModel(input.model) : undefined,
          parts: [{ type: "text", text: input.text }],
        },
      });
    },

    async changedFiles(sessionId) {
      const result = await client.session.diff({
        path: { id: sessionId },
        query: { directory },
      });
      return (result.data ?? [])
        .map((entry) => entry.file)
        .filter((file): file is string => typeof file === "string");
    },

    async cancel(sessionId) {
      await client.session.abort({ path: { id: sessionId }, query: { directory } });
    },
  };
}

export const CubicorePlugin: Plugin = async (input) => {
  const client = input.client as unknown as ClientLike;
  const directory = input.directory;
  const root = input.worktree || directory;

  const enforcer = new BudgetEnforcer();
  // Kept for live per-message activity only. Cost comes from `usage` below.
  const ledger = new UsageLedger();
  const usage = new SqliteTokenSource();

  /**
   * One event subscription, fanned out to every observer by session id. Both
   * the coordinator and the workers register here, which is why the coordinator
   * needs no separate plumbing.
   */
  const observers: RunObserver[] = [];

  /**
   * Every session-bearing object registers here so the single `event` hook can
   * reach it. `WorkerSessions` keeps its observers privately, so without this
   * registration worker sessions never see `session.idle` and every worker
   * blocks until its wall-clock ceiling.
   */
  const eventTargets: Array<{ onEvent(event: unknown): void }> = [];

  /** Cost for a finished session. The event-fed ledger always reads zero. */
  const runUsage = (): TokenUsage => {
    const totals = observers.map((observer) => observer.snapshot().usage);
    if (totals.length === 0) return usage.read("");
    return totals.reduce(
      (sum, one) => addUsage(sum, one),
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    );
  };

  const models = (workerModel?: string): ModelConfig => ({
    strong: STRONG_MODEL,
    cheap: workerModel || WORKER_MODEL,
  });

  /**
   * A single coordinator turn in its own session, so its context never reaches
   * a worker. Returns the assistant's text, which is the plan JSON.
   */
  async function coordinatorTurn(prompt: string, model: string): Promise<string> {
    const observer = new RunObserver();
    const created = await client.session.create({ query: { directory } });
    const sessionId = created.data?.id;
    if (!sessionId) throw new Error("opencode did not return a session id");
    observer.attach(sessionId);
    observers.push(observer);

    try {
      await client.session.prompt({
        path: { id: sessionId },
        query: { directory },
        body: {
          model: splitModel(model),
          agent: PLANNER_AGENT_ID,
          parts: [{ type: "text", text: prompt }],
        },
      });

      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (observer.snapshot().idle) break;
        await Bun.sleep(50);
      }
      return observer.snapshot().texts.join("\n").trim();
    } finally {
      const index = observers.indexOf(observer);
      if (index >= 0) observers.splice(index, 1);
    }
  }

  return {
    /**
     * Defines the constrained coordinator agent.
     *
     * Without this the plugin has no planner: `body.agent` would name an agent
     * that does not exist and opencode would silently fall back to `build`,
     * which reads the planner prompt as a coding request and returns prose. That
     * fallback is exactly the failure this hook exists to prevent, and it is
     * invisible — no error, just an unusable coordinator.
     */
    config: async (config) => {
      Object.assign(config, withPlannerAgent(config, {
        prompt:
          "You are the Cubicore coordinator. Emit one plan as JSON and nothing " +
          "else. Never use tools, never explore the repository, never explain.\n\n" +
          PLAN_SCHEMA_JSON,
        model: STRONG_MODEL,
      }));
    },

    /**
     * Routes every bus event to every observer. `RunObserver` filters by
     * session, so siblings never contaminate each other, and the ledger dedupes
     * the repeated `message.updated` events streaming produces — without which
     * every cost figure in this project would be inflated.
     */
    event: async ({ event }) => {
      for (const target of eventTargets) target.onEvent(event);
      for (const observer of observers) observer.on(event);

      const properties = (event as { properties?: Record<string, unknown> }).properties;
      void ledger;
    },

    /**
     * The one hard budget control. Verified: `maxOutputTokens` is a mutable
     * number on the hook output, so capping it makes the provider reject
     * over-length output rather than the plugin noticing afterwards.
     */
    "chat.params": async (hookInput, output) => {
      enforcer.chatParams(hookInput, output);
    },

    tool: {
      cubicore: tool({
        description:
          "Split a request into parallel workers with enforced file ownership and " +
          "token budgets, verify each result, and aggregate only what passed. Use for " +
          "genuinely independent files. The coordinator refuses interface changes, " +
          "renames and migrations, because parallel workers would collide.",
        args: {
          plan: tool.schema
            .string()
            .describe("A Cubicore plan as JSON, matching the plan schema."),
          workerModel: tool.schema
            .string()
            .optional()
            .describe("Override the worker model as provider/model."),
        },

        async execute({ plan, workerModel }, ctx) {
          const timer = new PhaseTimer();

          // No coordinator. The agent that called this tool already has the repo
          // context, so it splits better than a planner that cannot see the
          // code. Cubicore's job is making that split *safe*, not producing it.
          timer.start("validate");
          let parsed: Plan;
          try {
            parsed = parsePlan(plan);
          } catch (error) {
            timer.stop("validate");
            const problems =
              error instanceof MalformedPlan
                ? error.problems
                : [String(error)];
            return ["Malformed plan:", ...problems.map((p) => `- ${p}`)].join("\n");
          }

          if (parsed.topology === "refuse") {
            timer.stop("validate");
            return "This plan is marked refuse; nothing to dispatch.";
          }

          const validation = validatePlan(parsed, []);
          const topology = checkTopology(parsed);
          timer.stop("validate");

          // A cycle is not a mis-declaration to be corrected: two contracts
          // each needing the other's output is exactly the non-decomposable
          // case. Tell the caller to return `refuse` rather than retrying.
          const reject: string[] = validation.findings.map(
            (f) => `- [${f.code}] ${f.message}`,
          );
          if (topology.cycles.length > 0) {
            reject.push(
              `- [dependency-cycle] contracts need each other: ${topology.cycles
                .map((c) => c.join(" -> "))
                .join("; ")}. This is not a divide-and-conquer task — return \`refuse\`.`,
            );
          } else if (!topology.ok) {
            reject.push(
              `- [mis-declared-topology] declared \`${topology.declared}\` but the plan implies \`${topology.implied}\``,
            );
          }

          if (reject.length > 0) {
            return [
              "Plan rejected before dispatch — nothing was spent.",
              "",
              ...reject,
            ].join("\n");
          }

          const workers = new WorkerSessions(
            clientSpawner(client, directory),
            models(workerModel),
            enforcer,
            // Live events report zero usage; the session row is the truth.
            usage.resolver(),
          );
          eventTargets.push(workers);

          const recorder = new RunRecorder(parsed.topology, timer);

          timer.start("dispatch");
          const dispatched = await dispatch(
            parsed,
            workers.asRunner(),
            commandRunner(ctx.directory || directory),
            { repo: repoSource(root) },
          );
          timer.stop("dispatch");

          timer.start("aggregate");
          const run = recorder.finish(runUsage());
          const aggregated = aggregate(
            [...dispatched.accepted, ...dispatched.failed.map((f) => f.result)],
            dispatched.unresolved,
            run,
          );
          timer.stop("aggregate");

          const lines = [
            `${parsed.topology} · ${dispatched.accepted.length} passed, ` +
              `${dispatched.failed.length} flagged, ${dispatched.deferred.length} deferred`,
            summarise(run),
            "",
            ...aggregated.artifacts.map(
              (a) =>
                `- ${a.contractId}: ${a.status}` +
                (a.unresolved.length ? ` — ${a.unresolved.join("; ")}` : ""),
            ),
          ];

          if (dispatched.reviewFindings.length > 0) {
            lines.push("", "Bar integrity:");
            for (const finding of dispatched.reviewFindings) {
              lines.push(`- ${finding.code}: ${finding.evidence}`);
            }
          }

          return lines.join("\n");
        },
      }),
    },
  };
};

function commandRunner(cwd: string) {
  return {
    async run(command: string) {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { exitCode, output: `${stdout}\n${stderr}`.trim() };
    },
  };
}

function repoSource(root: string) {
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };

  return {
    anchors: (commands: readonly string[]) =>
      snapshotAnchors(commands, (p) => read(p.startsWith("/") ? p : `${root}/${p}`)),
    testFiles: () => {
      try {
        return [...new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx,mjs}").scanSync({
          cwd: root,
          onlyFiles: true,
        })];
      } catch {
        return [];
      }
    },
  };
}

const refusalNote = (request: string) =>
  [
    `Declined to split "${request.slice(0, 80)}".`,
    "",
    "The coordinator refuses when a request changes a shared interface or type,",
    "is a rename or migration, is cross-cutting, or is a dependent chain such as",
    "read → edit → test → fix. Parallel workers would collide on files a single",
    "linear pass would touch once.",
  ].join("\n");

export default CubicorePlugin;
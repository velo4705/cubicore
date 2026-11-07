import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { RunRecorder, summarise } from "../../telemetry/report";
import { UsageLedger } from "../../telemetry/usage";
import { addUsage, type TokenUsage } from "../../telemetry/types";
import { PhaseTimer } from "../../telemetry/timing";
import { readUsage } from "../../telemetry/adapters/opencode";
import { checkTopology } from "../../coordinator/topology";
import { DEFAULT_MODEL } from "../../mcp/model";
import { CUBICORE_AGENTS } from "../../mcp/agents";
import { parsePlan, MalformedPlan } from "../../coordinator/parse";
import { validatePlan } from "../../validate/plan";
import type { Plan } from "../../contracts/types";
import { dispatch } from "../../dispatch";
import { WorkerSessions, type SessionSpawner } from "../../dispatch/spawn";
import { ProgressSink } from "../../mcp/progress";
import { RunObserver } from "../../dispatch/observe";
import { BudgetEnforcer } from "../opencode/hooks";
import type { ModelConfig } from "../../dispatch/routing";
import { aggregate } from "../../aggregate";
import { snapshotAnchors } from "../../review/anchors";
import { PLAN_SCHEMA_JSON } from "../../contracts/schema";
import { SqliteTokenSource } from "../../telemetry/adapters/session-db";

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
const WORKER_MODEL = process.env.CUBICORE_WORKER_MODEL ?? DEFAULT_MODEL;

/**
 * The raw /api/* surface the 2.x host serves.
 *
 * The v1 SDK client in this package posts to routes the 2.x host no longer
 * serves (`POST /session` returns 405), so spawning goes through the v2 HTTP
 * API directly — the same way the MCP server talks to the form endpoints.
 * Model and agent are set on the session itself; the v2 prompt carries text
 * only, and there is no `tools` field (per-worker tool restriction lives in
 * the associate agent's own permission config in 2.x).
 */
export interface SpawnerTarget {
  /** Base URL of the opencode server, e.g. http://127.0.0.1:49374 */
  baseUrl: string;
  /** Directory the workers work in. */
  directory: string;
  /** Basic credentials, when the server requires them (OPENCODE_SERVER_*). */
  auth?: { username: string; password: string };
}

/** Auth from the environment, mirroring the rest of the codebase. */
export function authFromEnv(
  env: Record<string, string | undefined> = process.env,
): { username: string; password: string } | undefined {
  const username = env.OPENCODE_SERVER_USERNAME;
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!username || !password) return undefined;
  return { username, password };
}

function apiHeaders(target: SpawnerTarget): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.auth) {
    headers.Authorization = `Basic ${btoa(`${target.auth.username}:${target.auth.password}`)}`;
  }
  return headers;
}

interface ApiResponse {
  status: number;
  /** Parsed body, or null when the body is not JSON (e.g. the web UI HTML). */
  json: { data?: any } | null;
  text: string;
}

async function apiJson(
  target: SpawnerTarget,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    method,
    headers: apiHeaders(target),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: ApiResponse["json"] = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 405 / HTML error pages: leave json null and let callers report status.
  }
  return { status: response.status, json, text };
}

function describe(res: ApiResponse): string {
  const detail = res.json !== null ? JSON.stringify(res.json).slice(0, 200) : res.text.slice(0, 200);
  return `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
}

function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash < 0) return { providerID: "opencode", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function clientSpawner(
  target: SpawnerTarget,
  /** Caller session id. Associates are created as its children so the host UI shows them as sub-agents. */
  sessionID?: string,
): SessionSpawner {
  const route = (id: string, suffix: string) =>
    `/api/session/${encodeURIComponent(id)}${suffix}`;

  return {
    async create(input?: { title?: string; directory?: string }) {
      // parentID is what makes an associate appear in the host's own UI as a
      // sub-agent rather than an orphan session. Without it the work is real
      // but invisible to the founder, which is the whole complaint about a
      // tool call that blocks for a minute and returns a wall of text.
      //
      // `input.directory` is the per-worker worktree the dispatch path
      // creates. It overrides the shared root so each associate's filesystem
      // is its own — the scope gate depends on it for changedFiles attribution.
      const res = await apiJson(target, "POST", "/api/session", {
        ...(sessionID ? { parentID: sessionID } : {}),
        ...(input?.title ? { title: input.title } : {}),
        location: { directory: input?.directory ?? target.directory },
      });
      const id = (res.json?.data as { id?: string } | undefined)?.id;
      if (!id) {
        throw new Error(`opencode did not return a session id (${describe(res)})`);
      }
      return { sessionId: id };
    },

    async prompt(sessionId, input) {
      if (input.agent) {
        const res = await apiJson(target, "POST", route(sessionId, "/agent"), {
          agent: input.agent,
        });
        if (res.status >= 400) {
          throw new Error(`opencode rejected agent "${input.agent}" (${describe(res)})`);
        }
      }
      if (input.model) {
        const model = splitModel(input.model);
        const res = await apiJson(target, "POST", route(sessionId, "/model"), {
          model: { id: model.modelID, providerID: model.providerID },
        });
        if (res.status >= 400) {
          throw new Error(`opencode rejected model "${input.model}" (${describe(res)})`);
        }
      }
      const res = await apiJson(target, "POST", route(sessionId, "/prompt"), {
        text: input.text,
      });
      if (res.status >= 400) {
        throw new Error(`opencode rejected the prompt (${describe(res)})`);
      }
    },

    async changedFiles(sessionId) {
      const res = await apiJson(target, "GET", route(sessionId, "/diff"));
      if (res.status >= 400 || res.json === null) {
        throw new Error(`could not read the session diff (${describe(res)})`);
      }
      return (res.json.data as Array<{ file?: string }> | undefined)
        ?.map((entry) => entry.file)
        .filter((file): file is string => typeof file === "string") ?? [];
    },

    async cancel(sessionId) {
      const res = await apiJson(target, "POST", route(sessionId, "/interrupt"));
      // Best effort: an interrupt we cannot deliver is still reported by the
      // wall-clock ceiling in the caller.
      void res;
    },
  };
}

export const CubicorePlugin: Plugin = async (input) => {
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

  return {
    config: async (config) => {
      const agents = (config as { agent?: Record<string, unknown> }).agent ?? {};
      // Every agent Cubicore defines, refreshed rather than only created, so
      // an update to the instructions reaches a host that already has them.
      for (const agent of CUBICORE_AGENTS) {
        agents[agent.id] = agent.config;
      }
      (config as { agent?: Record<string, unknown> }).agent = agents;
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

          // Progress goes to stderr, not the return value: the return only
          // arrives when the run is over, which is too late to tell a slow
          // dispatch from a dead one.
          const progress = new ProgressSink(parsed.contracts);
          process.stderr.write(
            `[cubicore ${parsed.contracts.length} associates, topology ${parsed.topology}]\n`,
          );

          const workers = new WorkerSessions(
            // Parenting the worker sessions to the caller's makes each associate
            // appear in the host's own sub-agent UI rather than as an orphan.
            clientSpawner(
              { baseUrl: input.serverUrl.toString(), directory, auth: authFromEnv() },
              ctx.sessionID,
            ),
            models(workerModel),
            enforcer,
            // Live events report zero usage; the session row is the truth.
            usage.resolver(),
            progress.trace,
            // The project the work happens in, not the server's own cwd. The
            // scope check reads git status here and the worktrees live under
            // this root, so the two have to be the same tree.
            directory,
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
            dispatched.failed.map((f) => f.contractId),
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
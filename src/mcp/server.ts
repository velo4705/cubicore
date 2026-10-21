import { parsePlan, MalformedPlan } from "../coordinator/parse";
import { validatePlan } from "../validate/plan";
import { checkTopology } from "../coordinator/topology";
import { dispatch } from "../dispatch";
import { aggregate } from "../aggregate";
import { RunRecorder } from "../telemetry/report";
import { PhaseTimer } from "../telemetry/timing";
import { PLAN_SCHEMA_JSON } from "../contracts/schema";
import { ProgressSink } from "./progress";
import { startRun, finishRun, failRun, describe, getRun } from "./runs";
import { findCallerSession, verifyModel } from "./runtime";
import { agentAvailable, installAgent } from "./install";
import { deriveBaseline } from "../validate/baseline";
import { tryIt } from "../plan/try";
import { prepareRepository } from "../dispatch/changes";
import { capabilities, renderCapabilities } from "../plan/capabilities";
import { ASSOCIATE_AGENT_ID, BRIEF_DIR, briefs } from "./inline";
import { assessRaw, explain } from "../plan/assess";
import { questionsFrom, render as renderSurvey, survey } from "../plan/survey";
import {
  DEBUG_MD,
  PLAN_JSON,
  PLAN_MD,
  canExecute,
  loadPlan,
  readCycleState,
  renderDebugMd,
  renderPlanMd,
  writeCycleState,
  type TestFinding,
} from "./protocol";
import { mkdirSync, writeFileSync } from "node:fs";
import { runtimeFromEnv, workerSessions, type Runtime } from "./runtime";
import type { Plan } from "../contracts/types";

/**
 * Cubicore's MCP front-end.
 *
 * Two tools, split on purpose. `cubicore_plan` costs nothing and returns the
 * decomposition as data, so the founder can read it before anything is spent.
 * `cubicore_execute` takes that same plan and dispatches it. Splitting them is
 * what makes the Main agent's planning reviewable rather than something you
 * infer from a wall of text after the tokens are gone.
 *
 * MCP rather than plugin because clients surface MCP prompts as slash commands,
 * and because every other agent host speaks it. The plugin keeps only
 * `chat.params`, which is the one hook MCP cannot provide: an output cap is
 * attached to a chat message, and an MCP tool call has no message to attach one
 * to.
 */

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const PLAN_SCHEMA = PLAN_SCHEMA_JSON;

async function pumpEvents(
  runtime: Runtime,
  workers: { onEvent(event: unknown): void },
  signal: AbortSignal,
): Promise<void> {
  const auth = `Basic ${btoa(
    `${process.env.OPENCODE_SERVER_USERNAME ?? ""}:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`,
  )}`;
  const port = runtime.port;

  while (!signal.aborted) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${runtime.port}/event?directory=${encodeURIComponent(runtime.directory)}`,
        { headers: { Authorization: auth, Accept: "text/event-stream" }, signal },
      );
      const body = response.body;
      if (!body) return;

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) return;
        buffer += decoder.decode(value, { stream: true });

        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              workers.onEvent(JSON.parse(line.slice(5).trim()));
            } catch {
              // A malformed frame is not worth failing the run over.
            }
          }
        }
      }
    } catch {
      if (signal.aborted) return;
      await Bun.sleep(2000);
    }
  }
}

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: body }], isError };
}

/** Validate without dispatching. Free, and the reason the split exists. */
async function plan(raw: string, dir: string): Promise<ToolResult> {
  let parsed: Plan;
  try {
    parsed = parsePlan(raw) as Plan;
  } catch (error) {
    const problems = error instanceof MalformedPlan ? error.problems : [String(error)];
    return text(
      ["Malformed plan:", ...problems.map((p) => `- ${p}`), "", `Schema: ${PLAN_SCHEMA}`].join("\n"),
      true,
    );
  }

  if (parsed.topology === "refuse") {
    return text("This plan refuses to split. Nothing to dispatch, and that is a valid answer.");
  }

  const validation = validatePlan(parsed, deriveBaseline(dir));
  const topology = checkTopology(parsed);

  const problems: string[] = validation.findings.map((f) => `- [${f.code}] ${f.message}`);

  if (topology.cycles.length > 0) {
    problems.push(
      `- [dependency-cycle] ${topology.cycles.map((c) => c.join(" -> ")).join("; ")}. ` +
        "Not a divide-and-conquer task — return `refuse`.",
    );
  } else if (!topology.ok) {
    problems.push(
      `- [mis-declared-topology] declared \`${topology.declared}\` but the plan implies \`${topology.implied}\``,
    );
  }

  const summary = [
    `topology: ${parsed.topology}`,
    `associates: ${parsed.contracts.length} (budget allows ${parsed.graphBudget.nodes})`,
    ...parsed.contracts.map(
      (c) => `- ${c.id}: ${c.deliverable} -> ${c.writes.join(", ") || "(no writes)"}`,
    ),
  ];

  if (problems.length > 0) {
    return text(
      [`Plan rejected before dispatch — nothing was spent.`, "", ...problems, "", "--- plan ---", ...summary].join(
        "\n",
      ),
      true,
    );
  }

  return text([...summary, "", "Call execute with this plan to dispatch it."].join("\n"));
}

/** Best-effort caller session; undefined simply means the associates are not nested. */
async function resolveParent(parentSessionID?: string): Promise<string | undefined> {
  if (parentSessionID) return parentSessionID;
  try {
    return await findCallerSession(runtimeFromEnv());
  } catch {
    return undefined;
  }
}

async function runToCompletion(raw: string, runId: string, parentSessionID?: string): Promise<string> {
  const runtime = runtimeFromEnv();
  runtime.sessionID = parentSessionID;
  const dir = runtime.directory;

  let parsed: Plan;
  try {
    parsed = parsePlan(raw) as Plan;
  } catch (error) {
    const problems = error instanceof MalformedPlan ? error.problems : [String(error)];
    return `Malformed plan:\n${problems.map((p) => `- ${p}`).join("\n")}`;
  }

  if (parsed.topology === "refuse") {
    return "This plan refuses to split. Nothing dispatched.";
  }

  const validation = validatePlan(parsed, deriveBaseline(dir));
  const topology = checkTopology(parsed);
  if (!validation.ok || topology.cycles.length > 0 || !topology.ok) {
    return "Plan rejected before dispatch — nothing was spent. Run the plan tool to see why.";
  }

  const progress = new ProgressSink(parsed.contracts);
  process.stderr.write(
    `[cubicore ${parsed.contracts.length} associates, topology ${parsed.topology}]\n`,
  );

  const workers = workerSessions(runtime, progress);
  // The event connection never closes on its own, so it is aborted once
  // dispatch returns. Without this the process lives forever and the client
  // waits on a response it already has.
  const controller = new AbortController();
  const pump = pumpEvents(runtime, workers, controller.signal);
  pump.catch(() => {});

  const timer = new PhaseTimer();
  const recorder = new RunRecorder(parsed.topology, timer);

  const outcome = await dispatch(
    parsed,
    workers.asRunner(),
    { run: async (command: string) => {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd: runtime.directory,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode: await proc.exited, output: `${stdout}\n${stderr}`.trim() };
    } },
    {
      repo: {
        anchors: () => new Map(),
        testFiles: () => [],
      },
    },
  );

  const usage = outcome.accepted
    .concat(outcome.failed.map((f) => f.result))
    .reduce(
      (sum, r) => ({
        input: sum.input + r.usage.input,
        output: sum.output + r.usage.output,
        cacheRead: sum.cacheRead + r.usage.cacheRead,
        cacheWrite: sum.cacheWrite + r.usage.cacheWrite,
        reasoning: sum.reasoning + r.usage.reasoning,
        cost: sum.cost + r.usage.cost,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
    );
  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.reasoning;

  const aggregated = aggregate(
    [...outcome.accepted, ...outcome.failed.map((f) => f.result)],
    outcome.unresolved,
    recorder.finish(usage),
    outcome.failed.map((f) => f.contractId),
  );

  controller.abort();

  return [
      `${parsed.topology} · ${outcome.accepted.length} passed, ${outcome.failed.length} flagged, ` +
        `${outcome.deferred.length} deferred`,
      `tokens: ${totalTokens} (in ${usage.input}, out ${usage.output}, cache ${usage.cacheRead})`,
      "",
      ...aggregated.artifacts.map(
        (a) => `- ${a.contractId}: ${a.status}${a.unresolved.length ? ` — ${a.unresolved.join("; ")}` : ""}`,
      ),
    ].join("\n");
}

/**
 * Starts a run and returns immediately.
 *
 * The old shape blocked for the whole dispatch, so a client timeout meant the
 * verdict was lost entirely even though the work completed -- and a timeout
 * looks exactly like a hang. Returning a handle makes that unrepresentable:
 * there is nothing left to time out, and the caller decides how long to wait.
 */
async function execute(raw: string, parentSessionID?: string, dir = process.cwd()): Promise<ToolResult> {
  let parsed: Plan;
  try {
    parsed = parsePlan(raw) as Plan;
  } catch (error) {
    const problems = error instanceof MalformedPlan ? error.problems : [String(error)];
    return text(`Malformed plan:\n${problems.map((p) => `- ${p}`).join("\n")}`, true);
  }

  if (parsed.topology === "refuse") {
    return text("This plan refuses to split. Nothing dispatched.");
  }

  const validation = validatePlan(parsed, deriveBaseline(dir));
  const topology = checkTopology(parsed);
  if (!validation.ok || topology.cycles.length > 0 || !topology.ok) {
    return text("Plan rejected before dispatch — nothing was spent. Run plan to see why.", true);
  }

  // A withdrawn model fails silently -- the prompt is accepted and no reply
  // ever comes -- so it is checked before any token is spent, and the run is
  // refused loudly rather than dispatching associates that do nothing.
  const runtime = runtimeFromEnv();
  const model = await verifyModel(runtime);
  if (!model.verified) {
    return text(
      `Refusing to dispatch: the model is not usable.\n${model.reason ?? ""}\n` +
        `Set OPENCODE_CUBICORE_MODEL to a model the provider lists.`,
      true,
    );
  }
  if (model.reason) {
    process.stderr.write(`[cubicore] ${model.reason}\n`);
  }

  const run = startRun(parsed);
  // Nest under the Main agent's session so each associate appears in the host's
  // sub-agent view. A caller may pass one explicitly; otherwise the newest
  // session in this directory is almost always the caller.
  void resolveParent(parentSessionID).then((parent) => runToCompletion(raw, run.id, parent))
    .then((summary) => finishRun(run.id, summary))
    .catch((error) => failRun(run.id, error instanceof Error ? error.message : String(error)));

  return text(
    [
      `Started ${run.id} — ${parsed.contracts.length} associates, topology ${parsed.topology}.`,
      `Progress streams to the server log; the verdict does not arrive here.`,
      `Poll with the status tool using run id ${run.id}.`,
    ].join("\n"),
  );
}

function status(runId: string): ToolResult {
  const run = getRun(runId);
  if (!run) {
    return text(
      `Unknown run ${runId}. Run ids are process-local, so a restarted MCP server loses them.`,
      true,
    );
  }
  return text(describe(run));
}

/**
 * Plan: validate and write the artifacts. Costs nothing and dispatches nothing.
 *
 * Two files, deliberately. CUBICORE_PLAN.md is for the founder -- topology,
 * project size, who does what, why the split is what it is. CUBICORE_PLAN.json
 * is what Execute actually dispatches, and it is the only thing that is parsed.
 * A typo in the prose cannot silently change what gets built.
 */
/**
 * How many times a plan has been rejected for a directory.
 *
 * The execute -> test loop is capped at three cycles. The plan loop was not
 * capped at all: plan_write rejects a bad plan, the agent re-plans, it is
 * rejected again, and nothing stops that except the founder giving up. The
 * bound belongs in code rather than in the model's restraint.
 */
const PLAN_ATTEMPTS = 3;
const planAttempts = new Map<string, number>();

function attemptCount(directory: string): number {
  return planAttempts.get(directory) ?? 0;
}

async function planWrite(raw: string, directory: string): Promise<ToolResult> {
  const dir = directory;
  let parsed: Plan;
  try {
    parsed = parsePlan(raw) as Plan;
  } catch (error) {
    const problems = error instanceof MalformedPlan ? error.problems : [String(error)];
    return text(["Malformed plan:", ...problems.map((p) => `- ${p}`), "", `Schema: ${PLAN_SCHEMA_JSON}`].join("\n"), true);
  }

  // Specificity is checked before validity. "Build me a SaaS" produces a
  // syntactically valid plan whose write scopes claim the whole tree; it would
  // pass every structural check and dispatch four associates that collide.
  const assessed = assessRaw(raw);
  if (!assessed.ok) {
    return text(`Malformed plan: ${assessed.reason}`, true);
  }
  if (!assessed.assessment.plannable) {
    return text(explain(assessed.assessment), true);
  }

  const validation = validatePlan(parsed, deriveBaseline(dir));
  const topology = checkTopology(parsed);

  if (parsed.topology === "refuse") {
    return text("This plan refuses to split. That is a valid answer and nothing is written.");
  }

  const problems: string[] = validation.findings.map((f) => `- [${f.code}] ${f.message}`);
  if (topology.cycles.length > 0) {
    problems.push(`- [dependency-cycle] ${topology.cycles.map((c) => c.join(" -> ")).join("; ")}. Not divide-and-conquer.`);
  } else if (!topology.ok) {
    problems.push(`- [mis-declared-topology] declared \`${topology.declared}\`, implies \`${topology.implied}\``);
  }

  writeFileSync(`${directory}/${PLAN_JSON}`, raw);
  writeFileSync(`${directory}/${PLAN_MD}`, renderPlanMd(parsed, validation));

  if (problems.length > 0) {
    const attempts = attemptCount(dir) + 1;
    planAttempts.set(dir, attempts);
    const exhausted = attempts >= PLAN_ATTEMPTS;

    // The safety property is never relaxed. A plan whose write scopes overlap
    // is a genuine defect, and no amount of defaulting fixes it. What the cap
    // stops enforcing is preference: which files, which stack, which layout.
    const unsafe = problems.filter((p) =>
      /write-collision|catch-all|write-scope/.test(p),
    );

    if (exhausted && unsafe.length === 0) {
      return text(
        [
          `Plan accepted after ${attempts} attempts, with findings recorded rather than blocking.`,
          "",
          ...problems.map((p) => `- ${p}`),
          "",
          "These are preferences, not safety problems, and the plan was not reworked for them.",
        ].join("\n"),
      );
    }

    return text(
      [
        `Plan rejected -- ${PLAN_MD} and ${PLAN_JSON} written for inspection, but nothing will dispatch.`,
        exhausted
          ? `Attempt ${attempts} of ${PLAN_ATTEMPTS}. The remaining problems are not preferences, and they will keep being rejected until they are fixed.`
          : `Attempt ${attempts} of ${PLAN_ATTEMPTS}.`,
        "",
        ...problems.map((p) => `- ${p}`),
      ].join("\n"),
      true,
    );
  }

  return text(
    [`Wrote ${PLAN_MD} (for you) and ${PLAN_JSON} (dispatchable).`,
     `${parsed.contracts.length} associate(s), topology ${parsed.topology}. Nothing has run.`].join("\n"),
  );
}

/** Execute: dispatch ${PLAN_JSON}, honouring the cycle bound. */
async function executeFile(directory: string, parentSessionID?: string): Promise<ToolResult> {
  const statePath = `${directory}/.cubicore-cycle.json`;
  const state = readCycleState(statePath);
  const gate = canExecute(state);
  if (!gate.allowed) return text(gate.reason, true);

  let raw: string;
  try {
    raw = await Bun.file(`${directory}/${PLAN_JSON}`).text();
  } catch {
    return text(`No ${PLAN_JSON} in this directory. Run the plan command first.`, true);
  }

  const loaded = loadPlan(raw);
  if (!loaded.ok) return text(`Refusing to dispatch: ${loaded.reason}`, true);

  const parsed = loaded.plan;
  const run = startRun(parsed);
  writeCycleState(statePath, { cycle: state.cycle + 1, maxCycles: state.maxCycles, fromDebug: state.fromDebug });

  void resolveParent(parentSessionID)
    .then((parent) => runToCompletion(raw, run.id, parent))
    .then((summary) => finishRun(run.id, summary))
    .catch((error) => failRun(run.id, error instanceof Error ? error.message : String(error)));

  return text(
    [`${gate.reason}`, `Started ${run.id} -- ${parsed.contracts.length} associates, topology ${parsed.topology}.`,
     `Poll with status using ${run.id}.`].join("\n"),
  );
}

/**
 * Test: run the mechanical matrix and write findings.
 *
 * `error` and `warning` come from running each contract's own checks and block.
 * `judgment` -- is this useful, is it production ready, is this API free -- is
 * reported and annotated rather than blocking, because `judgment` checks are
 * rejected by the validator in v1. Auto-failing on taste is a loop with no
 * terminator; auto-passing on taste is worse, because it looks like a verdict.
 */
async function testRun(args: { findings?: TestFinding[] }, directory: string): Promise<ToolResult> {
  const statePath = `${directory}/.cubicore-cycle.json`;
  const state = readCycleState(statePath);
  const findings = args.findings ?? [];

  const blocking = findings.filter((f) => f.severity !== "judgment");
  const advisory = findings.filter((f) => f.severity === "judgment");

  writeFileSync(`${directory}/${DEBUG_MD}`, renderDebugMd(findings, state.cycle, state.maxCycles));

  if (blocking.length === 0) {
    return text(
      [`No blocking findings. Wrote ${DEBUG_MD} listing ${advisory.length} advisory item(s).`,
       advisory.length === 0
         ? "Nothing mechanical and nothing judgement-worthy was found."
         : "Advisory items are for a human to judge -- Test does not block on them."].join("\n"),
    );
  }

  const next = state.cycle + 1;
  const exhausted = next > state.maxCycles;
  return text(
    [`${blocking.length} blocking finding(s) written to ${DEBUG_MD}.`,
     exhausted
       ? `Cycle budget is exhausted (${state.cycle}/${state.maxCycles}). These are reported as unresolved for a human to triage; no further automatic runs.`
       : `Run execute again to address them. That is cycle ${next} of ${state.maxCycles}.`].join("\n"),
    true,
  );
}

/**
 * Emit the inline dispatch blueprint.
 *
 * Cubicore cannot invoke the host's sub-agent tool -- an MCP server offers
 * tools, it does not call the client's -- so the host makes the N calls and
 * this supplies one ready-to-dispatch instruction per associate. Emitting data
 * rather than acting is what makes a host without inline sub-tasks degrade to
 * the session path instead of failing.
 */
async function inlineBlueprint(directory: string, args: { projectKind?: string } = {}): Promise<ToolResult> {
  let raw: string;
  try {
    raw = await Bun.file(`${directory}/${PLAN_JSON}`).text();
  } catch {
    return text(`No ${PLAN_JSON} here. Run the plan command first.`, true);
  }

  const loaded = loadPlan(raw);
  if (!loaded.ok) return text(`Refusing to blueprint: ${loaded.reason}`, true);

  const cycleGate = canExecute(readCycleState(`${directory}/.cubicore-cycle.json`));
  if (!cycleGate.allowed) return text(cycleGate.reason, true);

  // The briefs are useless without the agent to dispatch them to. The host's
  // task tool rejects an unknown agent name, and the run silently falls back
  // to sessions -- so the check happens here, before six failed calls.
  const runtime = runtimeFromEnv();
  const agent = await agentAvailable(runtime.baseUrl, directory);
  const inlineReady = agent.present;
  if (!inlineReady) {
    process.stderr.write(
      `[cubicore] ${ASSOCIATE_AGENT_ID} not dispatchable: ` +
        `${agent.checked ? `host agents are ${agent.agents.join(", ") || "none"}` : agent.reason}.\n`,
    );
  }

  const written = briefs(loaded.plan, { projectKind: args.projectKind });
  mkdirSync(`${directory}/${BRIEF_DIR}`, { recursive: true });
  for (const file of written) {
    writeFileSync(`${directory}/${file.path}`, file.content);
  }

  const first = written.find((f) => f.path.endsWith(`01-${loaded.plan.contracts[0].id}.md`));

  return text(
    [
      `Wrote ${written.length} file(s) to ${BRIEF_DIR}/ -- one brief per associate, plus an index.`,
      "",
      inlineReady
        ? `Dispatch each to the \`${ASSOCIATE_AGENT_ID}\` sub-agent, in parallel, giving it its brief's path.`
        : `NOTE: the host has no \`${ASSOCIATE_AGENT_ID}\` agent. Dispatch to whichever sub-agent it does have ` +
          `(\`general\` works), keeping one brief each -- or call execute_file so Cubicore dispatches sessions itself.`,
      `An associate reads exactly one file and starts building.`,
      "",
      `When they return, run each contract's blocking checks and record the results with the test tool.`,
      "",
      "--- first brief, for shape ---",
      "",
      (first?.content ?? "").split("\n").slice(0, 22).join("\n"),
    ].join("\n"),
  );
}

/**
 * Look before asking.
 *
 * A founder who cannot name their own files cannot answer "which modules
 * should this touch?" — they will guess, and the guess becomes contracts that
 * claim everything. Surveying first turns an unanswerable question into a
 * choice: "not billing" is easy once `src/billing.ts` is on screen.
 */
async function research(directory: string): Promise<ToolResult> {
  const s = survey(directory);

  // The host's MCP servers. The agent already has their tools; it does not
  // have any indication they exist.
  let capabilityText = "";
  try {
    const runtime = runtimeFromEnv();
    const auth = `Basic ${btoa(
      `${process.env.OPENCODE_SERVER_USERNAME ?? ""}:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`,
    )}`;
    capabilityText = renderCapabilities(await capabilities(runtime.baseUrl, auth));
  } catch {
    capabilityText = "";
  }

  return text(
    [
      renderSurvey(s),
      capabilityText,
      "```",
      "",
      "Answer these before planning:",
      "",
      ...questionsFrom(s).map((q, i) => `${i + 1}. ${q}`),
    ].join("\n"),
  );
}

export const TOOLS = [
  {
    name: "plan",
    description:
      "Validate a Cubicore plan and return the decomposition without dispatching. " +
      "Costs nothing. Call this before cubicore_execute so the founder can read the split.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Plan JSON matching the Cubicore plan schema." },
        directory: { type: "string", description: "Working directory; defaults to the server's." },
      },
      required: ["plan"],
    },
    handler: async (args: { plan: string; directory?: string }) =>
      plan(args.plan, args.directory ?? process.cwd()),
  },
  {
    name: "execute",
    description:
      "Dispatch a validated Cubicore plan across parallel associates, gate each result, " +
      "and aggregate the artifacts. Progress streams to stderr while it runs.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Plan JSON previously accepted by plan." },
        parentSessionID: { type: "string", description: "Session to parent the associates to." },
      },
      required: ["plan"],
    },
    handler: async (args: { plan: string; parentSessionID?: string; directory?: string }) =>
      execute(args.plan, args.parentSessionID, args.directory ?? process.cwd()),
  },
  {
    name: "plan_write",
    description:
      "Validate a Cubicore plan and write CUBICORE_PLAN.md (for you) and CUBICORE_PLAN.json " +
      "(dispatchable). Costs nothing and dispatches nothing.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Plan JSON matching the Cubicore plan schema." },
        directory: { type: "string", description: "Working directory; defaults to the server's." },
      },
      required: ["plan"],
    },
    handler: async (args: { plan: string; directory?: string }) =>
      planWrite(args.plan, args.directory ?? process.cwd()),
  },
  {
    name: "execute_file",
    description:
      "Dispatch CUBICORE_PLAN.json across parallel associates. Returns a run id immediately; " +
      "poll it with status. Bounded by a cycle budget so fixes cannot loop without end.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Working directory; defaults to the server's." },
        parentSessionID: { type: "string", description: "Session to parent the associates to." },
      },
    },
    handler: async (args: { directory?: string; parentSessionID?: string }) =>
      executeFile(args.directory ?? process.cwd(), args.parentSessionID),
  },
  {
    name: "test",
    description:
      "Run the mechanical check matrix and write CUBICORE_DEBUG.md. Blocking findings are " +
      "errors and warnings; judgement calls are reported but never block.",
    inputSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          description: "Findings to record.",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["error", "warning", "judgment"] },
              source: { type: "string" },
              message: { type: "string" },
              fix: { type: "string" },
            },
            required: ["severity", "source", "message", "fix"],
          },
        },
        directory: { type: "string", description: "Working directory; defaults to the server's." },
      },
    },
    handler: async (args: { findings?: TestFinding[]; directory?: string }) =>
      testRun(args, args.directory ?? process.cwd()),
  },
  {
    name: "cubicore_try",
    description:
      "Actually run the delivered thing and report whether it works. Reads the plan's `try` " +
      "block -- the command, and what a working response looks like -- starts it, checks it, and " +
      "stops it. Use before declaring a project ready: a contract can be correct and still not run.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Working directory; defaults to the server's." },
        plan: { type: "string", description: "Plan JSON; omit to use CUBICORE_PLAN.json" },
      },
    },
    handler: async (args: { directory?: string; plan?: string }) => {
      const dir = args.directory ?? process.cwd();
      let raw = args.plan;
      if (!raw) {
        try {
          raw = await Bun.file(`${dir}/${PLAN_JSON}`).text();
        } catch {
          return text(`No ${PLAN_JSON} in ${dir}. Plan first, or pass the plan.`, true);
        }
      }

      const loaded = loadPlan(raw);
      if (!loaded.ok) return text(`Refusing: ${loaded.reason}`, true);

      const spec = loaded.plan.try;
      if (!spec) {
        return text(
          "This plan has no `try` block, so there is nothing to run. That is correct for a " +
            "library or a report. If this is something the founder is meant to start, the plan " +
            "should say how.",
        );
      }

      const outcome = await tryIt(spec, dir);
      const lines = [
        outcome.ok ? "It runs." : "It does not run.",
        outcome.detail,
        `(${Math.round(outcome.elapsedMs)}ms)`,
      ];
      if (outcome.status !== undefined) lines.push(`status: ${outcome.status}`);
      if (outcome.body) lines.push(`body: ${outcome.body.slice(0, 300)}`);
      if (outcome.output) lines.push("", "--- output ---", outcome.output.slice(-800));

      return text(lines.join("\n"), !outcome.ok);
    },
  },
  {
    name: "cubicore_prepare",
    description:
      "Prepare the working directory: initialise a git repository if there is " +
      "not one already, and record a baseline commit so that later changes can be " +
      "measured against it. Never touches a repository that already exists.",
    inputSchema: {
      type: "object",
      properties: { directory: { type: "string", description: "Working directory" } },
    },
    handler: async (args: { directory?: string }) => {
      const dir = args.directory ?? process.cwd();
      const result = prepareRepository(dir);
      if (result.alreadyInitialised) {
        return text(
          `Already a git repository (${dir}); left completely alone.` +
            (result.baseline ? ` Baseline: ${result.baseline.slice(0, 12)}` : ""),
        );
      }
      if (!result.initialised) {
        return text(`Could not prepare ${dir}: ${result.reason ?? "unknown"}`, true);
      }
      return text(
        result.committed
          ? `Initialised a git repository in ${dir} and committed a baseline, so later changes can be measured.`
          : `Initialised a git repository in ${dir}. Nothing to commit yet.`,
      );
    },
  },
  {
    name: "cubicore_install",
    description:
      "Install the cubicore-associate sub-agent into the host's own opencode config, so the " +
      "host can dispatch briefs inline. Required once per host. Restart opencode afterwards.",
    inputSchema: {
      type: "object",
      properties: { configPath: { type: "string", description: "Path to opencode.json; auto-detected otherwise" } },
    },
    handler: async (args: { configPath?: string }) => {
      const result = installAgent(args.configPath);
      if (!result.wrote) {
        return text(`No change: ${result.reason ?? "unknown reason"} (${result.path})`, !result.changed);
      }
      return text(
        [
          `Wrote ${ASSOCIATE_AGENT_ID} to ${result.path}.`,
          result.maxSteps
            ? `Also bounded the primary agent to ${result.maxSteps} steps, so a planning phase that keeps calling tools cannot run forever.`
            : result.maxStepsPreserved
              ? `The primary agent already had a step bound of its own; left it alone.`
              : ``,
          ``,
          `Restart opencode so it picks the agent up, then run /cubicore:execute.`,
        ].join("\n"),
      );
    },
  },
  {
    name: "dispatch_blueprint",
    description:
      "Write one brief per associate into CUBICORE_ASSOCIATES/, each a standalone document " +
      "carrying only that associate's write scope, what is off-limits, and its checks. Pass " +
      "projectKind so each knows what it is building toward. Cubicore cannot call the host's " +
      "sub-agent tool, so this is the data the host dispatches from; hosts without inline " +
      "sub-tasks ignore it and use sessions.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Working directory" },
        projectKind: {
          type: "string",
          description: "What kind of project this is -- web app, CLI, library, plugin, service. " +
            "Recorded in each brief so the associate knows what it is building toward.",
        },
      },
    },
    handler: async (args: { directory?: string; projectKind?: string }) =>
      inlineBlueprint(args.directory ?? process.cwd(), args),
  },
  {
    name: "research",
    description:
      "Survey the working directory -- languages, modules, exported names, existing commands -- " +
      "then ask the smallest set of questions grounded in what actually exists. Use before " +
      "planning any request that has not named specific files yet.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Working directory" },
        projectKind: {
          type: "string",
          description: "What kind of project this is -- web app, CLI, library, plugin, service. " +
            "Recorded in each brief so the associate knows what it is building toward.",
        },
      },
    },
    handler: async (args: { directory?: string; projectKind?: string }) => research(args.directory ?? process.cwd()),
  },
  {
    name: "status",
    description:
      "Poll a Cubicore run started by execute. Returns its current state, and the full " +
      "verdict once it finishes. Event-fed progress is not available here; the server log has it.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string", description: "Run id returned by execute." } },
      required: ["runId"],
    },
    handler: async (args: { runId: string }) => status(args.runId),
  },
];


/**
 * Slash-command surface.
 *
 * Tools are callable but invisible: the Main agent calls cubicore_execute and
 * the founder sees one blocked tool call and a wall of text. Prompts are the
 * half of MCP a client can turn into a command, which is what makes the
 * plan/execute split reviewable rather than something inferred afterwards.
 *
 * Whether a given client renders these as slash commands is the client's
 * choice, so the tools remain the reliable path and these are an improvement
 * where supported.
 */
const PROMPTS = [
  {
    name: "plan",
    description:
      "Research the repository, ask the founder what the repo cannot answer, then write " +
      "CUBICORE_PLAN.md and CUBICORE_PLAN.json. Dispatches nothing.",
    arguments: [{ name: "request", description: "What you want built; omit to use the current conversation", required: false }],
  },
  {
    name: "execute",
    description:
      "Dispatch a plan. Prefers the host's inline sub-agents so each associate renders as a " +
      "visible step; falls back to Cubicore's own sessions when the host has none.",
    arguments: [{ name: "plan", description: "Plan JSON; omit to use CUBICORE_PLAN.json" }],
  },
  {
    name: "test",
    description:
      "Run the mechanical check matrix over the delivered work and write CUBICORE_DEBUG.md. " +
      "Blocks on errors and warnings only -- judgement calls are reported, never blocking.",
    arguments: [],
  },
];

function promptFor(name: string, args: Record<string, string>) {
  if (name === "plan") {
    return {
      description: "Research, question, and plan in one pass.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`Plan this request:

${args.request ?? "(the current request in this conversation)"}

Work in this order, and do not skip a step.

**0. Prepare.** Call the prepare tool. If the project is not a git repository it
initialises one and records a baseline, so that "before" is a thing later changes
can be measured against. If it already is one, the tool leaves it alone.

**1. Research once.** Call the research tool. It reports the tree, the modules and
their exports, and the MCP servers connected to this workspace. Its tools are
already in your tool list -- use one when it does the job materially better than
you can by hand. Do not go exploring with the shell afterwards: the research
output already contains what you need, and a shell search for something that is
not there does not end.

**2. Decide what kind of request this is, and how much the founder wants to be
involved.**

*Is it a task or a goal?* "Build me a SaaS" is a goal. "Add a rate limiter to the
existing HTTP layer" is a task. A goal has to be narrowed before it can be
planned.

*Does the founder want to be consulted?* Read their tone, not just their words.
A founder who says "make no mistakes" or "just make it work" is delegating --
they do not know what they want and do not want to decide. A founder who is
exploring, who asks what you would suggest, or who has opinions about the shape
of the thing wants a conversation. Ask the second kind of founder. Do not ask the
first.

Both deserve a plan. The difference is whether the questions are worth their time.

**3. If they are delegating, decide everything and build.** Do not ask them
anything. Choose a conventional feature set, the conventional layout, the
conventional stack, and checks that can fail. Then make it work and prove it
runs. The deliverable is a working project, not a spec they did not write.

When you decide, choose what a common developer would choose. Boring,
well-documented and mainstream beats novel. Record what you decided in the plan
so the founder can override it.

**If they want a conversation, ask sparingly.** At most three questions, and only
ones where being wrong would cost a re-run. Everything else, decide and say what
you decided.

**4. Write the plan.** Produce the plan JSON and pass it to the plan tool, which
writes ${PLAN_MD} for the founder and ${PLAN_JSON} for the dispatcher.

If the result is something the founder is meant to start -- a server, a CLI, an
app -- the plan needs a \`try\` block saying how to run it and what working
looks like:

    "try": { "command": "npm start", "url": "http://127.0.0.1:3000/health",
             "expect": { "status": 200, "bodyContains": "\"status\":\"ok\"" } }

That block is what the try tool executes, and it is how the founder finds out it
works. A library or a report has nothing to run, and then the block is simply
absent -- that is correct, not a gap.

**Rules for the plan itself:**

- Every \`writes\` set must be disjoint from every other, and must name
  concrete files. A scope of \`src/**\` cannot be split safely and will be
  rejected.
- Split where the code actually separates, not where the word count does. Two
  contracts editing the same function are two contracts that collide.
- Every diff contract needs a check that \`can fail\`.
- A blocking check must set \`convergent: true\`. Typecheck and tests converge.
  Coverage thresholds and complexity limits do not -- mark those \`advisory\`.
- Never hand-compute a composed expected value. Derive it in the command, or
  assert a property that holds for every input.
- \`topology: "refuse"\` is a correct answer. Renames, interface changes and
  dependent chains are not divide-and-conquer tasks.

Plan JSON must match:

${PLAN_SCHEMA_JSON}`,
          },
        },
      ],
    };
  }

  if (name === "execute") {
    return {
      description: "Summon the associates and dispatch them.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`Execute CUBICORE_PLAN.md.

**What kind of project is this?** A web app, a CLI, a library, a plugin, a service — the
categories are whatever this project actually is, and you already know. Pass that to
\`dispatch_blueprint\` as projectKind so each associate knows what it is building toward.
There is no fixed taxonomy, and forcing one onto a project that does not fit it is how a
plan turns into guesswork.

**Size the team yourself**, from the project size in CUBICORE_PLAN.md. There is no maximum.
A small project might be one associate. A normal one might be three. A large one might be
eight. More associates is right when the work genuinely divides.

**Each associate gets its own brief.** That is what \`dispatch_blueprint\` writes — one
standalone document per associate into \`CUBICORE_ASSOCIATES/\`, each carrying only that
associate's write scope, what is off-limits, and its checks. Do not merge them into a
single brief and do not hand an associate another associate's brief. They are working at the
same time and must not read each other's scopes.

**Dispatch:**

1. Call \`dispatch_blueprint\` with the project kind. It reads CUBICORE_PLAN.json and writes
   one brief per associate plus an index.
2. Read the index to see who exists and what each owns.
3. Dispatch each associate to the \`${ASSOCIATE_AGENT_ID}\` sub-agent, in parallel, giving
   it its own brief's path. Each reads one file and starts building.
4. Collect every report separately. Never merge them — each contract is judged on its own
   checks alone, and a merged report hides which one failed.

**If the host has no sub-agent tool**, call \`execute\` instead and Cubicore dispatches the
sessions itself.

**When they return**, run every blocking check from CUBICORE_PLAN.json yourself and record
the results with the test tool.`,
          },
        },
      ],
    };
  }

  if (name === "test") {
    return {
      description: "Test the delivered work and record findings.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`Run the test tool over the work that was just delivered.

First, execute the blocking checks from every contract in ${PLAN_JSON} yourself and record what
actually happened -- the tool records findings, it does not discover them.

For each finding call test with:
  - severity "error"   -- the code is broken: it does not compile, a check exits non-zero
  - severity "warning" -- it works but something is off: a dead export, an unused path
  - severity "judgment" -- a call only a human can make: is this feature useful, is this
                           ready for production, is this API free to ship

Errors and warnings block. Judgement calls never block -- they are written to ${DEBUG_MD} as
advisory and left for the founder, because "judgment" checks are rejected by the validator
and a loop that waits on taste never terminates.

Give every finding a one-line concrete fix. Do not invent failures to justify an Execute cycle:
if nothing mechanical is wrong, say so.`,
          },
        },
      ],
    };
  }

  return { description: `Unknown prompt: ${name}`, messages: [] };
}

/** Minimal JSON-RPC 2.0 over stdio. MCP's transport, without the SDK. */
export async function serve(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  const write = (message: unknown) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);
      if (line.length === 0) continue;

      let request: { id?: unknown; method: string; params?: Record<string, unknown> };
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }

      const respond = (result: unknown) => {
        if (request.id !== undefined) write({ jsonrpc: "2.0", id: request.id, result });
      };

      if (request.method === "initialize") {
        respond({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: "cubicore", version: "0.1.0" },
        });
      } else if (request.method === "tools/list") {
        respond({
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      } else if (request.method === "tools/call") {
        const params = request.params ?? {};
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) {
          respond({ content: [{ type: "text", text: `unknown tool: ${String(params.name)}` }], isError: true });
          continue;
        }
        try {
          respond(await tool.handler((params.arguments ?? {}) as never));
        } catch (error) {
          respond({
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          });
        }
      } else if (request.method === "prompts/list") {
        respond({ prompts: PROMPTS });
      } else if (request.method === "prompts/get") {
        respond(promptFor(String(request.params?.name ?? ""), (request.params?.arguments ?? {}) as Record<string, string>));
      } else if (request.method === "ping") {
        respond({});
      }
    }
  }
}
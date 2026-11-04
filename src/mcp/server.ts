import { parsePlan, MalformedPlan } from "../coordinator/parse";
import { validatePlan } from "../validate/plan";
import { checkTopology } from "../coordinator/topology";
import { dispatch } from "../dispatch";
import { aggregate } from "../aggregate";
import { RunRecorder } from "../telemetry/report";
import { PhaseTimer } from "../telemetry/timing";
import { PLAN_SCHEMA_JSON } from "../contracts/schema";
import { ProgressSink } from "./progress";
import type { ContractState } from "./runs";
import {
  cancelRun, describe, failRun, finishRun, getRun, haltState, loadRuns, pauseRun,
  recordProgress, startRun,
} from "./runs";
import { findCallerSession, verifyModel } from "../adapters/opencode/runtime";
import { agentAvailable, installAgent } from "./install";
import { deriveBaseline } from "../validate/baseline";
import { previewIt } from "../plan/preview";
import { discardChanges, prepareRepository } from "../dispatch/changes";
import { nextLine } from "./next";
import { capabilities, renderCapabilities } from "../plan/capabilities";
import { ASSOCIATE_AGENT_ID, BRIEF_DIR, briefPath, briefs } from "./inline";
import { assessRaw, explain } from "../plan/assess";
import { questionsFrom, render as renderSurvey, survey } from "../plan/survey";
import {
  CONTEXT_MD,
  DEBUG_MD,
  PLAN_JSON,
  PLAN_MD,
  canExecute,
  loadPlan,
  readCycleState,
  renderContextMd,
  renderDebugMd,
  renderPlanMd,
  writeCycleState,
  type TestFinding,
} from "./protocol";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeFromEnv, workerSessions, type Runtime } from "../adapters/opencode/runtime";
import { cleanOrphanedWorktrees } from "../dispatch/worktree";
import {
  CrossPlanFinding,
  validateCrossPlan,
  validateCrossPlanCollisions,
  validateCrossPlanInterfaces,
} from "./protocol";
import type { Contract, Plan } from "../contracts/types";

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

/**
 * Creates the deployment tier question as an opencode form (native MCQ dialog).
 *
 * Uses opencode's built-in form mechanism so the founder gets a real question
 * UI instead of the model generating its own text MCQ. Best effort: if the
 * form can't be created (no session, no credentials, network error), the text
 * prompt still works as a fallback.
 */
async function createDeployTierForm(runtime: Runtime, sessionID: string): Promise<void> {
  const formId = `deploy-tier-${Date.now()}`;
  const body = {
    id: formId,
    title: "Choose your deployment tier",
    metadata: {},
    fields: [
      {
        key: "tier",
        title: "Deployment tier",
        description: "Which tier do you want to deploy to?",
        required: true,
        type: "string",
        options: [
          {
            value: "free",
            label: "Free tier",
            description: "No monthly cost, spin-down OK, shared resources, no custom domain",
          },
          {
            value: "paid",
            label: "Paid tier",
            description: "Always-on, managed database option, custom domain, no spin-down. Costs monthly.",
          },
          {
            value: "other",
            label: "Other",
            description: "Specify your own tier or constraint",
          },
        ],
      },
    ],
  };

  const username = process.env.OPENCODE_SERVER_USERNAME ?? "";
  const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
  try {
    await fetch(`${runtime.baseUrl}/api/session/${encodeURIComponent(sessionID)}/form`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        "x-opencode-directory": encodeURIComponent(runtime.directory),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    process.stderr.write(
      `[cubicore deploy] failed to create tier form: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

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

/**
 * Resolve which plan file to use for execute/continue.
 *
 * With no plan number: tries CUBICORE_PLAN.json, then falls back to
 * CUBICORE_PLAN_1.json (for the multi-member hackathon flow where a plan
 * was generated as _1 without a base file).
 *
 * With a plan number: reads CUBICORE_PLAN_N.json directly.
 */
function resolvePlanFile(directory: string, planNumber?: number): { planPath: string; mdPath: string; resolved: number | null } {
  if (planNumber !== undefined && planNumber !== null) {
    return {
      planPath: `${directory}/${PLAN_JSON.replace(".json", `_${planNumber}.json`)}`,
      mdPath: `${directory}/${PLAN_MD.replace(".md", `_${planNumber}.md`)}`,
      resolved: planNumber,
    };
  }

  // No number: try base file first, then _1 fallback.
  const basePlan = `${directory}/${PLAN_JSON}`;
  const baseMd = `${directory}/${PLAN_MD}`;
  const numberedPlan = `${directory}/${PLAN_JSON.replace(".json", "_1.json")}`;
  const numberedMd = `${directory}/${PLAN_MD.replace(".md", "_1.md")}`;

  if (existsSync(basePlan)) {
    return { planPath: basePlan, mdPath: baseMd, resolved: null };
  }
  if (existsSync(numberedPlan)) {
    return { planPath: numberedPlan, mdPath: numberedMd, resolved: 1 };
  }
  return { planPath: basePlan, mdPath: baseMd, resolved: null };
}


/**
 * Contracts an earlier run already satisfied, and which are unchanged.
 *
 * Both halves matter. "Passed last time" is not enough: if the refine
 * changed a contract's scope or its checks, it has to run again. So the
 * contract is compared field by field against the one that passed, and
 * only an identical contract is treated as done.
 */
export function satisfiedContracts(directory: string, plan: Plan): string[] {
  const runs = loadRuns(directory);
  const last = runs.find((r) => r.state === "done");
  if (!last) return [];

  // A contract is satisfied when its state is "done", or when it declares
  // steps and every step is done (even if the contract wrapper hasn't been
  // marked done yet — an interrupted run may have finished all steps but not
  // updated the contract state).
  const done = new Set<string>();
  for (const p of last.progress) {
    if (p.state === "done") {
      done.add(p.contractId);
      continue;
    }
    if (p.steps && Object.values(p.steps).length > 0 && Object.values(p.steps).every((s) => s === "done")) {
      done.add(p.contractId);
    }
  }
  if (done.size === 0) return [];

  const same = (a: Contract, b: Contract): boolean =>
    JSON.stringify([...a.writes].sort()) === JSON.stringify([...b.writes].sort()) &&
    JSON.stringify(
      a.checks.map((c) => [c.id, c.command, c.gating, c.convergent]).sort(),
    ) ===
      JSON.stringify(
        b.checks.map((c) => [c.id, c.command, c.gating, c.convergent]).sort(),
      );

  const satisfied: string[] = [];
  for (const contract of plan.contracts) {
    if (!done.has(contract.id)) continue;
    const previous = last.plan.contracts.find((c) => c.id === contract.id);
    if (previous && same(previous, contract)) satisfied.push(contract.id);
  }
  return satisfied;
}

/**
 * A reply that ends by saying what to type next.
 *
 * The founder should never have to remember the order -- debug is only
 * meaningful after a run delivered work, and execute is wrong before a plan
 * exists. The next command is derived from what is on disk, so it stays
 * right after a restart.
 */
function reply(body: string, directory: string, isError = false): ToolResult {
  const next = nextLine(directory);
  const tail = next ? `\n\n---\n${next}` : "";
  return { content: [{ type: "text", text: `${body}${tail}` }], isError };
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

  return reply([...summary, "", "Call execute with this plan to dispatch it."].join("\n"), dir);
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

async function runToCompletion(
  raw: string,
  runId: string,
  parentSessionID?: string,
  dir = process.cwd(),
  satisfiedOverride?: string[],
  preserveContractIds?: Set<string>,
  stepsProgress?: Map<string, Record<string, ContractState>>,
): Promise<{ summary: string; halted: "cancelled" | "paused" | null }> {
  const runtime = runtimeFromEnv();
  runtime.sessionID = parentSessionID;

  let parsed: Plan;
  try {
    parsed = parsePlan(raw) as Plan;
  } catch (error) {
    const problems = error instanceof MalformedPlan ? error.problems : [String(error)];
    return { summary: `Malformed plan:\n${problems.map((p) => `- ${p}`).join("\n")}`, halted: null };
  }

  if (parsed.topology === "refuse") {
    return { summary: "This plan refuses to split. Nothing dispatched.", halted: null };
  }

  const validation = validatePlan(parsed, deriveBaseline(dir));
  const topology = checkTopology(parsed);
  if (!validation.ok || topology.cycles.length > 0 || !topology.ok) {
    return { summary: "Plan rejected before dispatch — nothing was spent. Run the plan tool to see why.", halted: null };
  }

  const progress = new ProgressSink(parsed.contracts);
  process.stderr.write(
    `[cubicore ${parsed.contracts.length} associates, topology ${parsed.topology}]\n`,
  );

  const workers = workerSessions(runtime, progress, dir);
  // The event connection never closes on its own, so it is aborted once
  // dispatch returns. Without this the process lives forever and the client
  // waits on a response it already has.
  const controller = new AbortController();
  const pump = pumpEvents(runtime, workers, controller.signal);
  pump.catch(() => {});

  const timer = new PhaseTimer();
  const recorder = new RunRecorder(parsed.topology, timer);

  // Clean up orphaned worktrees from interrupted or refined runs so that
  // stale directories for removed contracts don't linger or collide.
  cleanOrphanedWorktrees(dir, parsed.contracts.map((c) => c.id));

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
      // A cancelled or paused run stops dispatching at the next stage.
      halt: () => haltState(runId, dir),
      // Integrate only what passed; discard what did not.
      collect: (contractId) => workers.collect(contractId),
      discard: (contractId) => workers.discard(contractId),
      // Contracts an earlier run already satisfied, unchanged, are not re-run.
      satisfiedContracts: satisfiedOverride ?? satisfiedContracts(dir, parsed),
      // Contracts whose worktrees should be preserved (not wiped) on resume.
      preserveContractIds,
      // Step completion states per contract, so associates skip completed steps.
      stepsProgress,
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

  return {
    summary: [
      `${parsed.topology} · ${outcome.accepted.length} passed, ${outcome.failed.length} flagged, ` +
        `${outcome.deferred.length} deferred`,
      `tokens: ${totalTokens} (in ${usage.input}, out ${usage.output}, cache ${usage.cacheRead})`,
      "",
      ...aggregated.artifacts.map(
        (a) => `- ${a.contractId}: ${a.status}${a.unresolved.length ? ` — ${a.unresolved.join("; ")}` : ""}`,
      ),
    ].join("\n"),
    halted: outcome.halted,
  };
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
  const auth = `Basic ${btoa(
    `${process.env.OPENCODE_SERVER_USERNAME ?? ""}:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`,
  )}`;
  const model = await verifyModel(runtime, undefined, auth);

  // A model that is not on the provider's list fails silently: the prompt is
  // accepted, the user message is recorded, and no reply ever comes. That is
  // worth refusing over.
  //
  // A model that could not be *checked* is not the same thing, and refusing
  // on that basis means one unreachable endpoint stops Cubicore running at
  // all. So: refuse only what is known to be wrong.
  if (model.verified === false && model.reason?.includes("is not available")) {
    return text(
      `Refusing to dispatch: the model is not usable.\n${model.reason}\n` +
        `Set OPENCODE_CUBICORE_MODEL to a model the provider lists.`,
      true,
    );
  }
  if (model.reason) {
    process.stderr.write(`[cubicore] ${model.reason}\n`);
  }

  const run = startRun(parsed, dir);
  // Nest under the Main agent's session so each associate appears in the host's
  // sub-agent view. A caller may pass one explicitly; otherwise the newest
  // session in this directory is almost always the caller.
  void resolveParent(parentSessionID)
    .then((parent) => runToCompletion(raw, run.id, parent, dir))
    .then(({ summary, halted }) => {
      if (halted === "cancelled") {
        cancelRun(run.id, dir, "cancelled by the founder");
      } else if (halted === "paused") {
        pauseRun(run.id, dir);
      } else {
        finishRun(run.id, dir, summary);
      }
    })
    .catch((error) => failRun(run.id, dir, error instanceof Error ? error.message : String(error)));

  return reply(
    [
      `Started ${run.id} — ${parsed.contracts.length} associates, topology ${parsed.topology}.`,
      `Progress streams to the server log; the verdict does not arrive here.`,
      `Poll with the status tool using run id ${run.id}.`,
    ].join("\n"),
    dir,
  );
}

/**
 * Poll a run, optionally waiting for it.
 *
 * Polling in a loop costs the agent a step each time, and the step budget is
 * finite: a run that took twenty polls could exhaust the budget before the
 * verdict arrived, leaving the agent with a dispatched run and no result. The
 * wait parameter makes one call enough.
 */
async function status(runId: string, waitMs = 0, directory?: string): Promise<ToolResult> {
  // Runs are stored per directory. Without one the tool looked in the server's
  // own working directory, which is usually not the project -- so a live run
  // was reported as unknown, and the message blamed a restarted server rather
  // than the wrong directory.
  const where = directory ?? process.cwd();
  const find = () => {
    const run = getRun(runId, where);
    if (!run) {
      return text(`No run ${runId} in ${where}. Pass the directory the run belongs to.`, true);
    }
    return null;
  };

  const missing = find();
  if (missing) return missing;

  // Capped below a typical MCP client timeout: a request that outlives the
  // client's patience is a transport error, not a verdict.
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, 20_000));
  while (Date.now() < deadline) {
    const run = getRun(runId, where);
    if (run && run.state !== "running") break;
    await Bun.sleep(1000);
  }

  return text(describe(getRun(runId, where)!));
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
 * The execute -> debug loop is capped at three cycles. The plan loop was not
 * capped at all: plan_write rejects a bad plan, the agent re-plans, it is
 * rejected again, and nothing stops that except the founder giving up. The
 * bound belongs in code rather than in the model's restraint.
 */
const PLAN_ATTEMPTS = 3;
const planAttempts = new Map<string, number>();

function attemptCount(directory: string): number {
  return planAttempts.get(directory) ?? 0;
}

async function planWrite(raw: string, directory: string, planNumber?: number): Promise<ToolResult> {
  const dir = directory;
  const resolved = resolvePlanFile(dir, planNumber);
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

  writeFileSync(resolved.planPath, raw);

  // Progress markers so the founder can see at a glance what is done,
  // what failed, and what still needs work -- and so continue knows where
  // to pick up.
  const contractProgress = new Map<string, ContractState>();
  const stepProgress = new Map<string, Map<string, ContractState>>();
  for (const run of loadRuns(directory)) {
    if (run.state !== "done" && run.state !== "failed" && run.state !== "cancelled") continue;
    for (const p of run.progress) {
      contractProgress.set(p.contractId, p.state);
      if (p.steps) {
        const stepMap = new Map<string, ContractState>();
        for (const [stepId, state] of Object.entries(p.steps)) stepMap.set(stepId, state);
        stepProgress.set(p.contractId, stepMap);
      }
    }
    break; // newest completed run wins
  }
  writeFileSync(
    resolved.mdPath,
    renderPlanMd(parsed, validation, { contracts: contractProgress, steps: stepProgress }),
  );

  // CUBICORE_CONTEXT.md is for humans who need to present the project in
  // person — hackathon demos, stakeholder reviews, onboarding. It is never
  // parsed by Execute or dispatch.
  if (parsed.context) {
    const contextMdPath = resolved.mdPath.replace("PLAN.md", "CONTEXT.md").replace("PLAN_", "CONTEXT_");
    writeFileSync(contextMdPath, renderContextMd(parsed.context));
  }

  if (problems.length === 0) {
    // A good plan clears the budget. Without this a refine would start at
    // attempt four and be accepted with findings even when it is perfect.
    planAttempts.delete(dir);
    // And it starts a new cycle. The budget is on one plan's revisions, not
    // on the project -- a fresh plan is a fresh set of chances.
    writeCycleState(`${directory}/.cubicore-cycle.json`, {
      cycle: 0,
      maxCycles: readCycleState(`${directory}/.cubicore-cycle.json`).maxCycles,
      fromDebug: false,
    });
  }

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

/**
 * Continue: resume the last run from where it stopped.
 *
 * Reads CUBICORE_PLAN.json (or CUBICORE_PLAN_N.json with a plan number),
 * skips contracts already done in the most recent completed run, and
 * dispatches only what remains. This is the daily-driver command: run it,
 * it picks up where the last run left off.
 *
 * Unlike execute, continue is exempt from the cycle budget -- it is
 * resuming interrupted work, not starting a new fix cycle.
 */
async function continueRun(directory: string, parentSessionID?: string, planNumber?: number): Promise<ToolResult> {
  const resolved = resolvePlanFile(directory, planNumber);
  let raw: string;
  try {
    raw = await Bun.file(resolved.planPath).text();
  } catch {
    return text(`No plan file found at ${resolved.planPath}. Run the plan command first.`, true);
  }

  const loaded = loadPlan(raw);
  if (!loaded.ok) return text(`Refusing to continue: ${loaded.reason}`, true);

  const parsed = loaded.plan;

  // When multiple plan files exist in this directory, verify their write
  // scopes are mutually disjoint and their interfaces are compatible so two
  // members don't accidentally overwrite each other's files or leave reads
  // unsatisfied.
  const collisions = validateCrossPlan(directory);
  if (collisions.length > 0) {
    return text(
      [
        `Refusing to continue: cross-plan problems detected.`,
        "",
        ...collisions.map((c) => `- ${c}`),
        "",
        "Fix the overlapping write scopes or unsatisfied reads before continuing.",
      ].join("\n"),
      true,
    );
  }

  const runs = loadRuns(directory);
  const last = runs[0]; // newest first

  // Build contract-level and step-level progress from the most recent run.
  const contractProgress = new Map<string, ContractState>();
  const stepProgress = new Map<string, Map<string, ContractState>>();
  const satisfied: string[] = [];

  if (last) {
    for (const p of last.progress) {
      contractProgress.set(p.contractId, p.state);
      if (p.steps) {
        const stepMap = new Map<string, ContractState>();
        for (const [stepId, state] of Object.entries(p.steps)) stepMap.set(stepId, state);
        stepProgress.set(p.contractId, stepMap);
      }

      // A contract is satisfied (skipped) when all its steps are done, or
      // when it has no steps and its state is "done".
      const allStepsDone = p.steps && Object.values(p.steps).length > 0 && Object.values(p.steps).every((s) => s === "done");
      if ((!p.steps && p.state === "done") || allStepsDone) {
        satisfied.push(p.contractId);
      }
    }
  }

  // Contracts that were in-flight ("running") when the run was interrupted
  // should have their worktrees preserved so they resume from where they
  // stopped instead of starting over.
  const runningContractIds = last
    ? new Set(last.progress.filter((p) => p.state === "running").map((p) => p.contractId))
    : new Set<string>();

  // Convert step progress from Map to Record for dispatch options.
  const stepsProgressRecord = new Map<string, Record<string, ContractState>>();
  for (const [cid, smap] of stepProgress) {
    stepsProgressRecord.set(cid, Object.fromEntries(smap));
  }

  const doneCount = satisfied.length;
  const failedCount = last?.progress.filter((p) => p.state === "failed").length ?? 0;
  const remaining = parsed.contracts.length - doneCount;

  if (remaining === 0) {
    return text(`All ${parsed.contracts.length} contract(s) already done. Nothing to continue.`);
  }

  // Continue is exempt from the cycle budget: it resumes interrupted work
  // rather than starting a new fix cycle. We still record the run for
  // history, but do not increment the cycle counter.
  const statePath = `${directory}/.cubicore-cycle.json`;
  const state = readCycleState(statePath);

  const run = startRun(parsed, directory);
  writeCycleState(statePath, state);

  void resolveParent(parentSessionID)
    .then((parent) => runToCompletion(raw, run.id, parent, directory, satisfied, runningContractIds, stepsProgressRecord))
    .then(({ summary, halted }) => {
      if (halted === "cancelled") {
        cancelRun(run.id, directory, "cancelled by the founder");
      } else if (halted === "paused") {
        pauseRun(run.id, directory);
      } else {
        finishRun(run.id, directory, summary);
      }

      // Re-render CUBICORE_PLAN.md with fresh progress from the latest run
      // so the founder sees up-to-date step markers after continue completes.
      try {
        const updatedRuns = loadRuns(directory);
        const latest = updatedRuns[0];
        const finalContractProgress = new Map<string, ContractState>();
        const finalStepProgress = new Map<string, Map<string, ContractState>>();
        if (latest) {
          for (const p of latest.progress) {
            finalContractProgress.set(p.contractId, p.state);
            if (p.steps) {
              const stepMap = new Map<string, ContractState>();
              for (const [stepId, state] of Object.entries(p.steps)) stepMap.set(stepId, state);
              finalStepProgress.set(p.contractId, stepMap);
            }
          }
        }
        writeFileSync(
          resolved.mdPath,
          renderPlanMd(parsed, { ok: true, findings: [] }, { contracts: finalContractProgress, steps: finalStepProgress }),
        );
      } catch {
        // Best-effort refresh; the run result is still valid even if MD refresh fails.
      }
    })
    .catch((error) => failRun(run.id, directory, error instanceof Error ? error.message : String(error)));

  return reply(
    [`${doneCount} done, ${failedCount} failed, ${remaining} to run.`,
     `Started ${run.id}. Poll with status using ${run.id}.`].join("\n"),
    directory,
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
async function debugRun(args: { findings?: TestFinding[] }, directory: string): Promise<ToolResult> {
  const statePath = `${directory}/.cubicore-cycle.json`;
  const state = readCycleState(statePath);
  const findings = args.findings ?? [];

  const blocking = findings.filter((f) => f.severity !== "judgment");
  const advisory = findings.filter((f) => f.severity === "judgment");

  writeFileSync(`${directory}/${DEBUG_MD}`, renderDebugMd(findings, state.cycle, state.maxCycles));

  if (blocking.length === 0) {
    const hasDebug = existsSync(join(directory, DEBUG_MD));
    const nextHint = hasDebug
      ? "\n\n---\nNext: /cubicore:deploy  (everything passes; the project is ready to put somewhere)\nOr: /cubicore:refine (add another feature to what was built) \u00b7 /cubicore:undo (discard the run and start over)"
      : "";
    return text(
      [`No blocking findings. Wrote ${DEBUG_MD} listing ${advisory.length} advisory item(s).`,
       advisory.length === 0
         ? "Nothing mechanical and nothing judgement-worthy was found."
         : "Advisory items are for a human to judge -- Test does not block on them.",
       nextHint].join("\n"),
      false,
    );
  }

  const next = state.cycle + 1;
  const exhausted = next > state.maxCycles;
  return reply(
    [`${blocking.length} blocking finding(s) written to ${DEBUG_MD}.`,
     exhausted
       ? `Cycle budget is exhausted (${state.cycle}/${state.maxCycles}). These are reported as unresolved for a human to triage; no further automatic runs.`
       : `Cycle ${next} of ${state.maxCycles}. Fix the findings, then execute again.`].join("\n"),
    directory,
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

  const contractList = loaded.plan.contracts.map(
    (c, i) =>
      `${i + 1}. \`${c.id}\` — writes: ${c.writes.join(", ") || "(none)"} — brief: \`${briefPath(i, c.id)}\``,
  ).join("\n");

  return text(
    [
      `Wrote ${written.length} file(s) to ${BRIEF_DIR}/ -- one brief per associate, plus an index.`,
      "",
      inlineReady
        ? `Dispatch ALL ${loaded.plan.contracts.length} associates to the \`${ASSOCIATE_AGENT_ID}\` sub-agent, in parallel, at the same time. Give each its own brief's path. Do not dispatch them one at a time.`
        : `NOTE: the host has no \`${ASSOCIATE_AGENT_ID}\` agent. Dispatch to whichever sub-agent it does have ` +
          `(\`general\` works), keeping one brief each -- or call execute so Cubicore dispatches sessions itself.`,
      "",
      "Associates to dispatch:",
      "",
      contractList,
      "",
      `An associate reads exactly one file and starts building.`,
      "",
      `When they return, run each contract's blocking checks and record the results with the debug tool.`,
      "",
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

/**
 * The clause every Cubicore tool leads with.
 *
 * The descriptions say what each tool does, which is not the same as when to
 * reach for it. A founder saying "use Cubicore to..." gives the model nothing
 * to match on unless the tools say they are the ones that answer to that
 * name. So every tool declares the trigger, in the same words, so the model
 * connects the phrase to the whole set rather than to one arbitrary tool.
 */
/**
 * How the agent ends a turn.
 *
 * The founder reads the agent's reply, not the tool output, so the next
 * command has to be stated in the reply. The tools also carry it -- derived
 * from the state on disk -- and the agent is told to repeat what they say.
 */
const ENDING = "End your reply by explicitly offering the next steps as /cubicore: commands -- " +
  "the recommended one first, then the alternatives. Say the command name and what it does. " +
  "Do not invent steps: the tool reads state on disk and knows what is true. " +
  "If the tool reported none, say the work is done. Let the founder choose; do not run the next step for them. ";


const WHEN = "Call this when the founder asks to use Cubicore, " +
  "or to plan, dispatch, test or check work that should be split across " +
  "parallel agents. ";

export const TOOLS = [
  {
    name: "plan",
    description:
      WHEN +
      "Validates a plan and returns the decomposition without dispatching. Costs " +
      "nothing. This is the entry point: call it before execute so the founder " +
      "can read the split before anything is spent.",
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
      WHEN +
      "Dispatches a validated plan across parallel associates, gates each result, " +
      "and aggregates the artifacts. Pass `plan` (inline JSON) or `planNumber` " +
      "(reads CUBICORE_PLAN_N.json from disk). `planNumber` is optional: omit it " +
      "to run the inline plan, or pass a number to dispatch a member plan file. " +
      "Returns a run id immediately. Then call status with that id and a generous " +
      "waitMs so one call returns the verdict -- polling in a loop spends the agent's " +
      "step budget, and a run can outlive it.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Plan JSON previously accepted by plan. Optional if planNumber is given." },
        parentSessionID: { type: "string", description: "Session to parent the associates to." },
        directory: { type: "string", description: "Working directory; defaults to the server's." },
        planNumber: { type: "integer", description: "Optional plan number; dispatches CUBICORE_PLAN_N.json from disk instead of the inline plan." },
      },
    },
    handler: async (args: { plan?: string; parentSessionID?: string; directory?: string; planNumber?: number }) => {
      const dir = args.directory ?? process.cwd();
      let raw: string;

      if (args.planNumber !== undefined && args.planNumber !== null) {
        // Disk path: read CUBICORE_PLAN_N.json, enforce cycle budget and cross-plan checks.
        const resolved = resolvePlanFile(dir, args.planNumber);
        try {
          raw = await Bun.file(resolved.planPath).text();
        } catch {
          return text(`No plan file found at ${resolved.planPath}. Run the plan command first.`, true);
        }

        const statePath = `${dir}/.cubicore-cycle.json`;
        const state = readCycleState(statePath);
        const gate = canExecute(state);
        if (!gate.allowed) return text(gate.reason, true);

        const collisions = validateCrossPlan(dir);
        if (collisions.length > 0) {
          return text(
            [
              `Refusing to dispatch: cross-plan problems detected.`,
              "",
              ...collisions.map((c) => `- ${c}`),
              "",
              "Fix the overlapping write scopes or unsatisfied reads before dispatching.",
            ].join("\n"),
            true,
          );
        }

        writeCycleState(statePath, { cycle: state.cycle + 1, maxCycles: state.maxCycles, fromDebug: state.fromDebug });
      } else if (args.plan) {
        // Inline path: run the plan passed directly.
        raw = args.plan;
      } else {
        return text("Pass either `plan` (inline JSON) or `planNumber` (read from disk).", true);
      }

      return execute(raw, args.parentSessionID, dir);
    },
  },
  {
    name: "plan_write",
    description:
      WHEN +
      "Validates a plan and writes CUBICORE_PLAN.md (for the founder) and " +
      "CUBICORE_PLAN.json (dispatchable). Costs nothing and dispatches nothing. " +
      "Pass planNumber to write CUBICORE_PLAN_N.md / CUBICORE_PLAN_N.json " +
      "(for multi-member flows where each member gets their own plan file).",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Plan JSON matching the Cubicore plan schema." },
        directory: { type: "string", description: "Working directory; defaults to the server's." },
        planNumber: { type: "integer", description: "Optional plan number; writes CUBICORE_PLAN_N files instead of the base files." },
      },
      required: ["plan"],
    },
    handler: async (args: { plan: string; directory?: string; planNumber?: number }) =>
      planWrite(args.plan, args.directory ?? process.cwd(), args.planNumber),
  },
  {
    name: "continue",
    description:
      WHEN +
      "Resumes the last run from where it stopped. Reads CUBICORE_PLAN.json, " +
      "skips contracts already done in the most recent completed run, and " +
      "dispatches only what remains. Use this as the daily-driver command: " +
      "run it, and it picks up where the last run left off. " +
      "Exempt from the cycle budget. Pass planNumber to resume CUBICORE_PLAN_N.json.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Working directory; defaults to the server's." },
        parentSessionID: { type: "string", description: "Session to parent the associates to." },
        planNumber: { type: "integer", description: "Optional plan number; resumes CUBICORE_PLAN_N.json instead of the base file." },
      },
    },
    handler: async (args: { directory?: string; parentSessionID?: string; planNumber?: number }) =>
      continueRun(args.directory ?? process.cwd(), args.parentSessionID, args.planNumber),
  },
  {
    name: "debug",
    description:
      WHEN +
      "Reviews, tests, and fixes the delivered work until the issues disappear. Runs the " +
      "mechanical check matrix over every contract, finds broken syntax, layout, buttons, " +
      "loose code, and 0-day style defects, and keeps fixing and re-checking until clean " +
      "(except un-fixable warnings/errors, which are reported after repeated attempts). " +
      "Writes CUBICORE_DEBUG.md.",
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
      debugRun(args, args.directory ?? process.cwd()),
  },
  {
    name: "preview",
    description:
      WHEN +
      "Actually runs the delivered thing and keeps it available. Reads the plan's " +
      "`preview` block -- the command, and what a working response looks like -- starts it, " +
      "checks it, and leaves it running for web apps, or runs the built software. Use to " +
      "inspect the real result before declaring a project ready.",
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

      const spec = loaded.plan.preview;
      if (!spec) {
        return text(
          "This plan has no `preview` block, so there is nothing to run. That is correct for a " +
            "library or a report. If this is something the founder is meant to start, the plan " +
            "should say how.",
        );
      }

      const outcome = await previewIt(spec, dir);
      const lines = [
        outcome.ok ? "Preview started." : "It does not run.",
        outcome.detail,
        `(${Math.round(outcome.elapsedMs)}ms)`,
      ];
      if (outcome.pid !== undefined) lines.push(`pid: ${outcome.pid}`);
      if (outcome.status !== undefined) lines.push(`status: ${outcome.status}`);
      if (outcome.body) lines.push(`body: ${outcome.body.slice(0, 300)}`);
      if (outcome.output) lines.push("", "--- output ---", outcome.output.slice(-800));
      if (outcome.pid !== undefined) lines.push("", "Leave it running for the founder to test.");

      return text(lines.join("\n"), !outcome.ok);
    },
  },
  {
    name: "prepare",
    description:
      WHEN +
      "Prepares the working directory: initialise a git repository if there is " +
      "not one already, and record a baseline commit so that later changes can be " +
      "measured against it. Never touches a repository that already exists.",
    inputSchema: {
      type: "object",
      properties: { directory: { type: "string", description: "Working directory" } },
    },
    handler: async (args: { directory?: string }) => {
      const dir = args.directory ?? process.cwd();
      const result = await prepareRepository(dir);
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
    name: "install",
    description:
      WHEN +
      "Installs the Cubicore sub-agents into the host's own opencode config, so the " +
      "host can dispatch them. Required once per host. Restart opencode afterwards.",
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
      WHEN +
      "Writes one brief per associate into CUBICORE_ASSOCIATES/, each a standalone " +
      "document carrying only that associate's write scope, what is off-limits, and its " +
      "checks. Pass projectKind so each knows what it is building toward. Cubicore " +
      "cannot call the host's sub-agent tool, so this is the data the host dispatches " +
      "from; hosts without inline sub-tasks ignore it and use sessions.",
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
      WHEN +
      "Surveys the working directory -- languages, modules, exported names, existing commands, " +
      "and the MCP servers connected to this workspace -- then asks the smallest set of " +
      "questions grounded in what actually exists. Use before planning any request that has " +
      "not named specific files yet.",
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
    name: "estimate",
    description:
      WHEN +
      "Estimates what a plan will cost before anything is spent: how many associates, " +
      "the token and wall ceilings, and who owns what. This is the plan's own budget, " +
      "not a prediction -- a free model's latency varies by more than the difference " +
      "between the arms, so read the time as a floor.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Plan JSON; omit to use CUBICORE_PLAN.json" },
        directory: { type: "string", description: "Working directory" },
      },
    },
    handler: async (args: { plan?: string; directory?: string }) => {
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
      if (!loaded.ok) return text(`Cannot estimate: ${loaded.reason}`, true);

      const plan = loaded.plan;
      const tokens = plan.contracts.reduce((sum, c) => sum + (c.budget?.tokens ?? 0), 0);
      const wall = plan.contracts.reduce((sum, c) => sum + (c.budget?.wallMs ?? 0), 0);

      return text(
        [
          `Estimate for ${plan.contracts.length} associate(s), topology ${plan.topology}.`,
          ``,
          `  token ceiling: ${tokens.toLocaleString()}`,
          `  wall ceiling:  ${Math.round(wall / 1000)}s across the plan`,
          `  graph budget:  ${plan.graphBudget.nodes} nodes, ${plan.graphBudget.edges} edges`,
          ``,
          ...plan.contracts.map(
            (c) => `  - ${c.id}: ${c.writes.join(", ") || "(report)"} -- ${Math.round((c.budget?.wallMs ?? 0) / 1000)}s, ${(c.budget?.tokens ?? 0).toLocaleString()} tokens`,
          ),
          ``,
          `This is the plan's own budget, not a prediction. Treat the time as a floor: a free`,
          `model's latency has been observed to vary by more than half between identical runs.`,
        ].join("\n"),
      );
    },
  },
  {
    name: "undo",
    description:
      WHEN +
      "Undoes the last execution: discards the changes it made and returns the tree to " +
      "the baseline commit Cubicore recorded before any associate started. Also removes " +
      "the plan files if asked. This destroys work.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run to undo; omit for the most recent." },
        directory: { type: "string", description: "Working directory" },
        discardPlan: { type: "boolean", description: "Also remove the plan files." },
      },
    },
    handler: async (args: { runId?: string; directory?: string; discardPlan?: boolean }) => {
      const dir = args.directory ?? process.cwd();
      const runs = loadRuns(dir);
      const run = args.runId ? runs.find((r) => r.id === args.runId) : runs[0];
      if (!run) return text("There is nothing to undo in this directory.", true);

      const undone = await discardChanges(run, dir);
      if (args.discardPlan) {
        for (const file of [PLAN_JSON, PLAN_MD, DEBUG_MD]) {
          try {
            await Bun.file(`${dir}/${file}`).unlink();
          } catch {}
        }
      }
      return text(
        [
          undone.ok
            ? `Undid ${run.id}: the tree is back at the baseline commit.`
            : `Could not discard the changes: ${undone.reason}`,
          args.discardPlan ? "The plan files were removed as well." : "The plan files are still there.",
        ].join("\n"),
      );
    },
  },
  {
    name: "status",
    description:
      WHEN +
      "Polls a run started by execute. Returns its current state, and the full verdict " +
      "once it finishes. Event-fed progress is not available here; the server log has it.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id returned by execute." },
        directory: {
          type: "string",
          description:
            "Working directory the run belongs to. Runs are stored per directory, and " +
            "without this the tool looks in the server's own working directory, which is " +
            "usually not the project.",
        },
        waitMs: {
          type: "integer",
          description:
            "How long to wait for the run to finish, in milliseconds. Pass a generous " +
            "value so one call returns the verdict instead of a loop of polls -- each " +
            "poll costs a step from the agent's budget. Zero returns the current state.",
        },
      },
      required: ["runId"],
    },
    handler: async (args: { runId: string; waitMs?: number; directory?: string }) =>
      status(args.runId, args.waitMs, args.directory),
  },
];

/**
 * OpenCode splits the text typed after a slash command into shell-like tokens
 * and maps them onto the MCP prompt's declared arguments *by position*
 * (`Object.fromEntries((prompt.arguments ?? []).map((arg, i) => [arg.name, tokens[i] ?? ""]))`).
 * Declaring a single `request` argument therefore delivers only the first word
 * of what the founder typed. Declaring one slot per possible word is how the
 * whole request survives the client: it fills them in order and leaves the
 * unused slots empty, and the server joins them back together verbatim.
 */
const REQUEST_WORDS = 96;

/** Declares one positional slot per word the founder might type after a command. */
function wordArguments(name: string, description: string) {
  return [
    { name, description, required: false },
    ...Array.from({ length: REQUEST_WORDS - 1 }, (_, index) => ({
      name: `${name}${index + 2}`,
      description: "Next word",
      required: false,
    })),
  ];
}

const PLAN_REQUEST_ARGUMENTS = wordArguments("request", "What you want built");
const REFINE_CHANGE_ARGUMENTS = wordArguments("change", "What to change or add");

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
export const PROMPTS = [
  {
    name: "plan-demo",
    description:
      "Plan a demo or MVP. Same shape as plan, but optimised for shipping fast: simpler stack, " +
      "fewer checks, cut corners where safe, and a single deployable artifact.",
    arguments: PLAN_REQUEST_ARGUMENTS,
  },
  {
    name: "plan-full",
    description:
      "Plan a full enterprise product from scratch. Same shape as plan, but optimised for " +
      "production: thorough contracts, health endpoints, config, observability, CI/CD, and " +
      "checks that can fail on real systems.",
    arguments: PLAN_REQUEST_ARGUMENTS,
  },
  {
    name: "execute",
    description:
      "Dispatch a plan. Prefers the host's inline sub-agents so each associate renders as a " +
      "visible step; falls back to Cubicore's own sessions when the host has none. " +
      "Reads CUBICORE_PLAN.json by default, falls back to CUBICORE_PLAN_1.json, " +
      "or CUBICORE_PLAN_N.json when planNumber is given.",
    arguments: [
      { name: "plan", description: "Plan JSON; omit to use CUBICORE_PLAN.json" },
      { name: "planNumber", description: "Optional plan number; dispatches CUBICORE_PLAN_N.json." },
    ],
  },
  {
    name: "refine",
    description:
      "Improve the current plan before running it, or add features to a project that has " +
      "already been built. Reads the existing plan, works out what should change, and " +
      "rewrites the plan.",
    arguments: REFINE_CHANGE_ARGUMENTS,
  },
  {
    name: "undo",
    description:
      "Undoes the last execution, discarding its changes and returning the tree to the " +
      "baseline commit. Destroys work, so it says what it would do first.",
    arguments: [],
  },
  {
    name: "estimate",
    description:
      "Estimates what the current plan will cost before anything is spent: how many " +
      "associates, the token and wall ceilings, and the shape of the pipeline.",
    arguments: [],
  },
  {
    name: "continue",
    description: "Resume the last run from where it stopped, skipping contracts already done. " +
      "Exempt from the cycle budget. Reads CUBICORE_PLAN.json by default, " +
      "falls back to CUBICORE_PLAN_1.json, or CUBICORE_PLAN_N.json when planNumber is given.",
    arguments: [
      { name: "planNumber", description: "Optional plan number; resumes CUBICORE_PLAN_N.json." },
    ],
  },
  {
    name: "deploy",
    description:
      "Plans how to deploy the project. Asks about the tier, offers deployment stacks with a " +
      "recommendation, writes the deploy files, and explains the manual steps.",
    arguments: [],
  },
  {
    name: "debug",
    description:
      "Review, test, and fix the delivered work until the issues disappear. Writes " +
      "CUBICORE_DEBUG.md. Repeats automatically (outside a running preview) until the same " +
      "failure no longer reproduces; un-fixable warnings/errors are reported after retries.",
    arguments: [],
  },
  {
    name: "preview",
    description:
      "Run the delivered thing and keep it available. Starts/keeps the localhost server for web apps, or runs the built software. Leaves it running for the founder to inspect. Uses the plan's own preview block.",
    arguments: [],
  },
  {
    name: "status",
    description:
      "Report what the run in flight is doing (planned / finished / failed / skipped contracts), wait if not done, and clearly state which contract failed and suggest `/cubicore:debug` or `/cubicore:refine`.",
    arguments: [],
  },
];

/** Joins the positional word arguments back into the text the founder typed. */
function wordsFrom(args: Record<string, string>, name: string): string {
  const words: string[] = [];
  for (let index = 1; index <= REQUEST_WORDS; index++) {
    const word = args[index === 1 ? name : `${name}${index}`];
    if (typeof word !== "string") break;
    if (word.length > 0) words.push(word);
  }
  return words.join(" ").trim();
}

/**
 * Renders the shared plan-writing prompt structure used by plan-demo and
 * plan-full. Only the title and the "decide scope" section differ; the steps,
 * the contract rules, and the schema are identical.
 */
function renderPlanPrompt(title: string, decideScope: string, request: string, extraNote?: string): string {
  if (request.length === 0) {
    return `
${title}

${ENDING}

No request was supplied. Do NOT guess the project. Do NOT write any plan. Do NOT call any tools.
Reply only with: "What do you want me to build?"
`;
  }



  return `
${title}

${ENDING}
Work in this order, and do not skip a step.

**0. Prepare.** Call the prepare tool. If the project is not a git repository it
initialises one and records a baseline. If it already is one, the tool leaves it alone.

**1. Decide scope.** ${decideScope}

**Framework & language:** If the user named a framework or programming language(s) to achieve the build, use only that — recommended is ignored. If the user did not mention any, use the recommended (most widely used) framework and language for this domain (React/Vite + TypeScript for web, Python + tkinter for desktop GUI, Express + JavaScript for APIs) and state it clearly in the plan. Do not ask — pick and state.

**Style (web apps only):** If the user wants a web app and did not specify a style, recommend and use Modern Minimal (clean typography, neutral palette, subtle shadows) — state it in the plan. If the user specified glassmorphism, cute, retro, dark, or any other style, use only that and do not override.

**User request:** ${request}${extraNote}

**2. Write the plan.** Build exactly what the user requested above. Do not
substitute, upgrade, or replace it with a project of your own choosing. Then
produce the plan JSON and pass it to the plan tool, which writes
CUBICORE_PLAN.md for the founder, CUBICORE_PLAN.json for the dispatcher, and
CUBICORE_CONTEXT.md for team members who need to present the project in person.

The plan needs:
- A \`summary\` field — one or two sentences describing what this project is,
  shown at the top of CUBICORE_PLAN.md so the founder understands the product
  at a glance.
- A \`context\` field — narrative context for human readers: problem, users,
  use cases, benefits, demo flow, and future work. Rendered at the top of
  CUBICORE_CONTEXT.md so team members can present the project in person.
  Never affects what gets built.
- \`graphBudget.nodes\` at least the number of contracts.
- \`graphBudget.edges\` at least the read/write dependencies between contracts.
- If the result can be started or served, a top-level \`preview\` object with the command,
  and any URL/readyLine/expectation needed to know it came up. If the result is a
  library or a report with nothing to run, omit it.

Every contract needs:
- A \`schema\` field describing its output
- At least one check that \`can fail\`
- Disjoint \`writes\` from every other contract

Plan JSON must match the schema below, but the OUTPUT must NOT include "$schema", "type", "required", or "additionalProperties" fields — those are validator metadata only. Every contract must have exactly: id, objective, reads, writes, forbidden, deliverable, schema, doneWhen, checks, budget. No other fields (no "preview", no "$schema").

${PLAN_SCHEMA_JSON}`;
}

/** Builds the demo/MVP decide-scope section. */
function planDemoScope(): string {
  return "This is a demo or MVP. Build exactly what the founder requested. " +
    "Do not choose your own project idea and do not substitute a different product. " +
    "Skip observability, health endpoints, CI/CD, and multi-stage config unless the " +
    "founder explicitly asks. One contract per file or feature; prefer fewer, larger " +
    "contracts over many small ones. The goal is a single deployable artifact, not a " +
    "production system. If the request names a framework or tool, include an installation " +
    "contract that installs its dependencies (npm, pip, cargo, apt, brew, etc.).";
}

/** Builds the enterprise decide-scope section. */
function planFullScope(): string {
  return "This is an enterprise product, built from scratch. Build exactly what the " +
    "founder requested. Do not choose your own project idea and do not substitute a " +
    "different product. Stack with health endpoints, config, observability, CI/CD, and " +
    "proper error handling. Split into one contract per bounded context or service; " +
    "prefer more, smaller contracts with clear boundaries. Every contract needs a check " +
    "that can fail against a real system. If the request names a framework or tool, " +
    "include an installation contract that installs its dependencies (npm, pip, cargo, " +
    "apt, brew, etc.).";
}

export function promptFor(name: string, args: Record<string, string>) {
  if (name === "plan-demo") {
    const existingPlan = existsSync(join(process.cwd(), "CUBICORE_PLAN.json"));
    return {
      description: "Plan a demo or MVP — ship fast, cut safe corners.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: renderPlanPrompt(
              "Plan a demo or MVP of this project.",
              planDemoScope(),
              wordsFrom(args, "request"),
              existingPlan ? "\n\nNOTE: A plan already exists at CUBICORE_PLAN.json. If the founder wants to change or add a feature to the existing project, use `/cubicore:refine` instead of `/cubicore:plan-demo`. Only proceed with a new plan here if the founder explicitly confirms they want to start over." : ""
            ),
          },
        },
      ],
    };
  }

  if (name === "plan-full") {
    const existingPlan = existsSync(join(process.cwd(), "CUBICORE_PLAN.json"));
    return {
      description: "Plan a full enterprise product from scratch — production-ready, observable, CI/CD.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: renderPlanPrompt(
              "Plan a full enterprise product from scratch.",
              planFullScope(),
              wordsFrom(args, "request"),
              existingPlan ? "\n\nNOTE: A plan already exists at CUBICORE_PLAN.json. If the founder wants to change or add a feature to the existing project, use `/cubicore:refine` instead of `/cubicore:plan-full`. Only proceed with a new plan here if the founder explicitly confirms they want to start over." : ""
            ),
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


${ENDING}
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

**Plan files.** Cubicore reads CUBICORE_PLAN.json by default. If that file is not present,
it falls back to CUBICORE_PLAN_1.json. Pass planNumber to dispatch CUBICORE_PLAN_N.json
instead (for multi-member flows where each member has their own plan file).

**Dispatch:**

1. Call \`dispatch_blueprint\` with the project kind. It reads CUBICORE_PLAN.json and writes
   one brief per associate plus an index.
2. Read the index to see who exists and what each owns.
3. Dispatch ALL associates to the \`${ASSOCIATE_AGENT_ID}\` sub-agent, in parallel, at the same time.
   Give each its own brief's path. Do not dispatch them one at a time -- launch every
   associate simultaneously so they work concurrently. Each reads one file and starts
   building.
4. Collect every report separately. Never merge them — each contract is judged on its own
   checks alone, and a merged report hides which one failed.

**If the host has no sub-agent tool**, call \`execute\` instead and Cubicore dispatches the
sessions itself.

**When they return**, run every blocking check from CUBICORE_PLAN.json yourself and record
the results with the debug tool.`,
          },
        },
      ],
    };
  }

  if (name === "refine") {
    const change = wordsFrom(args, "change");
    return {
      description: "Improve the plan, or add features to what was built.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`${ENDING}Improve the current plan${change ? ` to: ${change}` : ""}.

${change ? "" : "Ask what should change, or work it out from the plan and from the work already done and say what you decided.\n\n"}Read CUBICORE_PLAN.md and CUBICORE_PLAN.json first, and CUBICORE_DEBUG.md if it exists. Then decide which of two things this is.

**Adding.** The existing work stays and something new is added. Keep every existing contract
exactly as it is -- same id, same write scope, same checks -- and add contracts for the new
work. An existing contract that passed is not re-run, so do not restate it or change its
scope to make room: the new contracts must be disjoint from the old ones on their own.

**Changing.** The existing work is wrong or the approach is different. Then rewrite the
contracts it affects, remove the ones that no longer apply, and merge any that would overlap
a neighbour.

Either way, the new plan describes the whole project. Do not write a plan containing only the
new contracts -- the plan is what the founder reads to understand the project.

Every write scope stays disjoint and concrete, and every contract still has a check that can
fail. A contract that passed before and is unchanged is not re-run, so a contract you did not
touch costs nothing; a contract you did touch is run again from scratch.

Do not dispatch. Refining is a decision the founder makes after reading the diff, and the
next command will say so.

If the plan is for a project that was already built, read the files and not just the plan --
the new contracts must not assume the old ones still exist.`,
          },
        },
      ],
    };
  }

  if (name === "undo") {
    return {
      description: "Undo the last execution.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`${ENDING}Undo the last execution.

Call the undo tool. It discards the changes the last run made and returns the tree to
the baseline commit Cubicore recorded before any associate started, and removes the files
that run created.

This destroys work, so before calling it, say in one line what will be discarded --
which files, and whether the plan files go too. Then call the tool and report what it
actually did. If the tool could not do it, say so plainly rather than claiming the
tree is clean.`,
          },
        },
      ],
    };
  }

  if (name === "estimate") {
    return {
      description: "What the plan will cost.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`${ENDING}Estimate what the current plan will cost.

Call the estimate tool and report what it says: how many associates, the token and
wall ceilings, and which files each one owns.

Then add one line of honest interpretation. The time figure is the plan's own budget,
not a prediction -- a free model's latency has been observed to vary by more than half
between identical runs, so it is a floor, not an estimate of what will happen.`,
          },
        },
      ],
    };
  }

  if (name === "continue") {
    return {
      description: "Resume the last run from where it stopped.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`Resume the last run from where it stopped.


${ENDING}
Read CUBICORE_PLAN.md to see the progress markers: ✅ done, ❌ failed, 🔄 running,
⏳ not started. Then call the continue tool -- it reads CUBICORE_PLAN.json, skips
contracts already done, and dispatches only what remains.

Report how many contracts are done, how many failed, and how many remain.`,
          },
        },
      ],
    };
  }

  if (name === "deploy") {
    return {
      description: "Plan the deployment.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`Plan how to deploy this project.


${ENDING}
Work in this order, and do not skip a step. You ask; the founder answers. Do not
answer your own questions — stop after asking and wait for the reply.

**1. What tier?** A deployment tier question has been sent to the founder as a
form. Wait for them to answer it. Do not pick a tier yourself, and do not offer
stacks until the founder has answered.

**2. Once the founder picks a tier, I will offer three or four real deployment
stacks** — each with what it costs, what it gives up, and what is annoying about
it. One will be marked as my recommendation, but the founder can pick
differently.

**3. Then I write the deploy files** — container definition, platform
configuration, environment example, health check, CI workflow. Concrete paths,
disjoint scopes, and a check that can fail.

**4. Then I explain the manual steps** to deploy by hand, in order, with the
environment variables you have to set. Assume you have never deployed this stack
before.

Do not deploy anything. Write the files and explain the steps.`,
          },
        },
      ],
    };
  }

  if (name === "status") {
    return {
      description: "Report the state of the run in flight.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`${ENDING}Call the status tool with the run id, and wait for it.

Give it a generous waitMs -- long enough that one call returns the verdict rather than a
partial state. A run outlives the tool call that started it, so the founder may be back
days later and the run may still be going. Polling in a loop spends the founder's steps
instead of the run's.

Report what the run did: how many associates finished, how many failed, and what each
failure was. If it is still running, say so and say how long it has been going.`,
          },
        },
      ],
    };
  }

  if (name === "preview") {
    return {
      description: "Run the delivered thing and keep it available.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`${ENDING}Run the preview tool. It starts what the plan says to start and checks that it came up
the way the plan said it would, and it leaves the result running.

The plan's preview block is the founder's own statement of what working looks like -- the command,
the ready line, and how long to wait for it. For a web app this is a localhost server the founder
can open. For built software it is the built artifact, running.

If there is no preview block, say so plainly. A library or a report has nothing to run, and that
is a correct plan, not a failure. Do not invent something to start.

If it fails, report the actual output rather than a summary of it. The founder is finding out
whether this works, and "it did not start" is only useful with the reason attached.`,
          },
        },
      ],
    };
  }

  if (name === "debug") {
    return {
      description: "Review, test, and fix the delivered work until the issues disappear.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`${ENDING}Run the debug tool over the work that was just delivered.

First, execute the blocking checks from every contract in ${PLAN_JSON} yourself and record what
actually happened -- the tool records findings, it does not discover them.

Debug is a loop, not a report:

1. Review the code and configuration for layout, buttons, loose code, broken syntax,
   dead imports/exports, and 0-day style defects. Tests are not a substitute for reading.
2. Run the mechanical check matrix and the baseline checks.
3. For each real failure, turn it into a narrowly-scoped fix contract, dispatch it, and
   re-run the check that caught it.
4. Repeat until the same failure no longer reproduces.

For each finding call debug with:
  - severity "error"   -- the code is broken: it does not compile, a check exits non-zero
  - severity "warning" -- it works but something is off: a dead export, an unused path
  - severity "judgment" -- a call only a human can make: is this feature useful, is this
                           ready for production, is this API free to ship

Errors and warnings block. Judgement calls never block -- they are written to ${DEBUG_MD} as
advisory and left for the founder, because judgment checks are rejected by the validator and a
loop that waits on taste never terminates. Un-fixable warnings/errors that cannot be repaired
after repeated attempts are recorded as unresolved for a human to triage.

Give every finding a one-line concrete fix. Do not invent failures to justify another cycle:
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
        // Handled concurrently. Awaiting the handler inside the stdin read
        // loop meant one slow tool call stopped every later request from being
        // read at all -- a status poll behind a long wait never arrived.
        void (async () => {
          try {
            respond(await tool.handler!((params.arguments ?? {}) as never));
          } catch (error) {
            respond({
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            });
          }
        })();
      } else if (request.method === "prompts/list") {
        respond({ prompts: PROMPTS });
      } else if (request.method === "prompts/get") {
        const name = String(request.params?.name ?? "");
        const args = (request.params?.arguments ?? {}) as Record<string, string>;
        // For deploy, create the tier question as an opencode form (native MCQ)
        // before handing the prompt to the model. The model must not answer its
        // own question; it asks and waits for the founder's reply.
        if (name === "deploy") {
          try {
            const runtime = runtimeFromEnv();
            const sessionID = await findCallerSession(runtime);
            if (sessionID) {
              await createDeployTierForm(runtime, sessionID);
            } else {
              process.stderr.write(
                "[cubicore deploy] no caller session found; tier form not created\n",
              );
            }
          } catch (error) {
            process.stderr.write(
              `[cubicore deploy] failed to create tier form: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }
        respond(promptFor(name, args));
      } else if (request.method === "ping") {
        respond({});
      }
    }
  }
}
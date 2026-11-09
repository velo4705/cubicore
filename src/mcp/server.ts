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
import type { FactoryFit } from "../factory/fit";
import {
  cancelRun, describe, failRun, finishRun, getRun, haltState, loadRuns, pauseRun,
  recordProgress, startRun,
} from "./runs";
import { findCallerSession, verifyModel } from "../adapters/opencode/runtime";
import { agentAvailable, installAgent } from "./install";
import { deriveBaseline } from "../validate/baseline";
import { nodePathEnv, previewIt } from "../plan/preview";
import { discardChanges, prepareRepository } from "../dispatch/changes";
import { nextLine } from "./next";
import { capabilities, renderCapabilities } from "../plan/capabilities";
import { ASSOCIATE_AGENT_ID, BRIEF_DIR, briefPath, briefs } from "./inline";
import { assessRaw, explain } from "../plan/assess";
import { applyFounderFactoryChoice, assessFactoryFit, factoryFitOptions, renderFit, synthesizeSingleAgentPlan } from "../factory/fit";
import { buildRetrospective, renderRetrospective } from "../factory/retrospect";
import { enterFactoryLifecycle, completeFactoryLifecycle, factoryLifecycleStatusLine, blockFactoryLifecycle } from "../factory/lifecycle";
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
  renderFactoryFit,
  writeCycleState,
  type TestFinding,
} from "./protocol";
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
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
type FormResult = { ok: boolean; status: number; body: string };

function frmId(prefix: string): string {
  return "frm_" + prefix + "_" + Date.now();
}

async function postForm(runtime: Runtime, sessionID: string, body: unknown): Promise<FormResult> {
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "";
  const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
  try {
    const res = await fetch(`${runtime.baseUrl}/api/session/${encodeURIComponent(sessionID)}/form`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        "x-opencode-directory": encodeURIComponent(runtime.directory),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text.slice(0, 400) };
  } catch (error) {
    return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

type ProjectKind = "desktop" | "web" | "other";

/** Read the plan in the current directory and decide what kind of thing it builds. */
async function detectProjectKind(directory: string): Promise<ProjectKind> {
  for (const name of ["CUBICORE_PLAN.json", "CUBICORE_PLAN_1.json"]) {
    try {
      const raw = await Bun.file(`${directory}/${name}`).text();
      const plan = JSON.parse(raw) as { summary?: string; context?: { problem?: string; useCases?: string[] }; contracts?: Array<{ objective?: string; writes?: string[] }>; preview?: { command?: string; url?: string } };
      const hay = [
        plan.summary ?? "",
        plan.context?.problem ?? "",
        ...(plan.context?.useCases ?? []),
        ...(plan.contracts ?? []).flatMap((c) => [c.objective ?? "", ...(c.writes ?? [])]),
        plan.preview?.command ?? "",
      ].join(" ").toLowerCase();
      if (/tkinter|desktop|gui|tkinterapp|window|canvas/.test(hay)) return "desktop";
      if (/browser|web app|react|vite|html|http|localhost|express|three\.js/.test(hay)) return "web";
    } catch {
      // Ignore missing/unparseable plan; fall through to the next candidate.
    }
  }
  return "other";
}

function stackOptions(kind: ProjectKind, tier: string): Array<{ value: string; label: string; description: string }> {
  if (kind === "desktop") {
    return [
      { value: "github-releases", label: "GitHub Releases (recommended)", description: "$0 · signed assets + install notes per OS · auto-update is manual · annoying: churn at release time" },
      { value: "source-zip", label: "Source zip + install script", description: "$0 · anyone with Python runs it · annoying: users must install Python and tkinter themselves" },
      { value: "pyinstaller", label: "PyInstaller bundled binary", description: "~$0 · works without a Python install · ~40MB downloads · annoying: OS-specific builds, slower startup" },
      { value: "flatpak", label: "Flatpak (Linux)", description: "$0 · sandboxed Linux install · annoying: needs Flatpak setup, and the app's filesystem access needs explicit permissions" },
      { value: "other", label: "Other", description: "Specify your own distribution, constraint, or platform" },
    ];
  }
  const isFree = tier !== "paid" && tier !== "other";
  return isFree
    ? [
        { value: "static-host", label: "Static host (recommended)", description: "$0 · zero-config · you serve dist/ with npx serve yourself · annoying: no CI — you rebuild by hand on every deploy" },
        { value: "cloudflare-pages", label: "Cloudflare Pages", description: "$0 · git-push CI · custom domain + HTTPS free · annoying: requires pushing to a GitHub repo and configuring a build command" },
        { value: "github-pages", label: "GitHub Pages", description: "$0 · git-push CI · annoying: needs a public repo (or GitHub Pro for private), slower CDN propagation than Cloudflare" },
        { value: "other", label: "Other", description: "Specify your own stack, constraint, or platform" },
      ]
    : [
        { value: "railway", label: "Railway (recommended)", description: "~$5/mo baseline · one buildpack · managed Postgres + custom domains built in · weakest: you ride their pricing changes" },
        { value: "fly", label: "Fly.io", description: "$0–few $/mo for tiny apps · Docker-native · annoying: registry auth + fly.toml config by hand" },
        { value: "render", label: "Render", description: "$0 trial · $7/mo static · $19+/mo services · git deploy · slower cold start than Railway" },
        { value: "other", label: "Other", description: "Specify your own stack, constraint, or platform" },
      ];
}

async function createDeployTierForm(runtime: Runtime, sessionID: string): Promise<FormResult> {
  const formId = frmId("deploy-tier");
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

  const result = await postForm(runtime, sessionID, body);
  if (!result.ok) {
    process.stderr.write(`[cubicore deploy] failed to create tier form: HTTP ${result.status} ${result.body}\n`);
  }
  return result;
}

/**
 * Creates the stack question as an opencode form (native MCQ dialog).
 *
 * Asked one question per form, one after the other: tier first, then this
 * stack question — so the agent answers the first before it has to think
 * about the second. Best effort: if the form can't be created (no session,
 * no credentials, network error), the text prompt still works as a fallback.
 */
async function createDeployStackForm(
  runtime: Runtime,
  sessionID: string,
  tier: string,
  kind: ProjectKind = "web",
): Promise<FormResult> {
  const formId = frmId("deploy-stack");
  const body = {
    id: formId,
    title: "Choose your deployment stack",
    metadata: {},
    fields: [
      {
        key: "stack",
        title: "Deployment stack",
        description: `Tier: ${tier}. Pick a stack — each includes cost, tradeoffs, and what is annoying about it.`,
        required: true,
        type: "string",
        options: stackOptions(kind, tier),
      },
    ],
  };

  const result = await postForm(runtime, sessionID, body);
  if (!result.ok) {
    process.stderr.write(`[cubicore deploy] failed to create stack form: HTTP ${result.status} ${result.body}\n`);
  }
  return result;
}

/**
 * The factory-fit question, asked the same way Founders see everything else:
 * a native opencode form, one question, sent to their own session. The form
 * is only created when the plan is accepted — a rejected plan gets no
 * question because there is nothing yet worth dispatching.
 */
async function createFactoryFitForm(runtime: Runtime, sessionID: string, fit: FactoryFit, contractCount: number): Promise<FormResult> {
  const options = factoryFitOptions(fit, contractCount);
  const recommended = options.recommendedValue === "single-agent" ? options.singleAgent : options.team;
  const other = options.recommendedValue === "single-agent" ? options.team : options.singleAgent;
  const formId = frmId("factory-fit");
  const body = {
    id: formId,
    title: "Choose your factory",
    metadata: {},
    fields: [
      {
        key: "choice",
        title: "Factory fit",
        description: options.description,
        required: true,
        type: "string",
        options: [
          { value: recommended.value, label: `${recommended.label} (recommended)`, description: recommended.description },
          { value: other.value, label: other.label, description: other.description },
          { value: "other", label: "Other", description: "Something else, or a constraint you want stated" },
        ],
      },
    ],
  };
  const result = await postForm(runtime, sessionID, body);
  if (!result.ok) {
    process.stderr.write(`[cubicore plan_write] failed to create factory-fit form: HTTP ${result.status} ${result.body}\n`);
  }
  return result;
}

/**
 * Ask the founder how they want this to run. Returns the reply lines to append —
 * empty when there is no caller session to reach (e.g. invoked from the CLI), so
 * nothing pretends a question went out.
 */
async function askFounderFactoryFit(fit: FactoryFit, contractCount: number): Promise<string[]> {
  try {
    const runtime = runtimeFromEnv();
    const sessionID = await findCallerSession(runtime);
    if (!sessionID) return [];
    const result = await createFactoryFitForm(runtime, sessionID, fit, contractCount);
    if (!result.ok) {
      return [
        "",
        `Factory-fit form delivery FAILED (HTTP ${result.status}: ${result.body}). ` +
          "Do not claim a form was sent. Ask the question now with your question tool: " +
          `"Team of ${contractCount}, or single agent?" — never as plain text.`,
      ];
    }
    return [
      "",
      "The factory-fit question was sent to the founder as a form. Relay the decision above " +
        "verbatim, then stop. Do NOT ask in plain text. Do NOT call execute, record_factory_fit " +
        "or anything else until the founder answers. If the answer overrides the recommendation, " +
        "call record_factory_fit with their choice before /cubicore:execute.",
    ];
  } catch (error) {
    process.stderr.write(`[cubicore plan_write] factory-fit ask failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return [];
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

/**
 * Progress markers so the founder can see at a glance what is done, what
 * failed, and what still needs work -- and so continue knows where to pick
 * up. Shared by plan_write and record_factory_fit so the markdown the founder
 * sees after either call reflects the same disk state.
 */
function progressFromDisk(
  directory: string,
  contracts: Plan["contracts"],
): { contracts: Map<string, ContractState>; steps: Map<string, Map<string, ContractState>> } {
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
  const persisted = readPersistedProgression(directory);
  for (const contract of contracts) {
    const state = persisted[contract.id];
    if (state) {
      contractProgress.set(contract.id, state);
      if (contract.steps?.length) {
        const stepMap = new Map<string, ContractState>();
        for (const step of contract.steps) stepMap.set(step.id, state);
        stepProgress.set(contract.id, stepMap);
      }
    }
  }
  return { contracts: contractProgress, steps: stepProgress };
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
  const fit = assessFactoryFit({ topology: parsed.topology, contracts: parsed.contracts });
  parsed.factoryFit = fit;
  writeFileSync(`${dir}/.cubicore-factory-fit.json`, JSON.stringify(fit, null, 2));


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
    blockFactoryLifecycle(dir, `malformed plan: ${problems[0] ?? "unknown problems"}`);
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

  const unionWrites = [...new Set(parsed.contracts.flatMap((c) => c.writes))];
  enterFactoryLifecycle(dir, "dispatch", `topology=${parsed.topology}; contracts=${parsed.contracts.length}`);
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
      root: dir,
      unionWrites,
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

  // The integration wave. If the plan says the merged tree must still build,
  // run that proof NOW — before anything is declared done. This is the last
  // chance to catch a broken union whose pieces pass their own gates: pieces
  // on paper that combine into a broken build are not delivered.
  let integrationOutcome: Awaited<ReturnType<typeof runIntegration>> | undefined;
  if (parsed.integration) {
    integrationOutcome = await runIntegration(parsed.integration, dir);
  }

  // observe → integrate → verify transitions, recorded in .cubicore-factory-state.json
  enterFactoryLifecycle(dir, "observe", `accepted=${outcome.accepted.length}; failed=${outcome.failed.length}; deferred=${outcome.deferred.length}`);
  completeFactoryLifecycle(dir, "workers done or failed");
  enterFactoryLifecycle(dir, "integrate", "worktrees collected / copied back");
  completeFactoryLifecycle(dir, "worktrees handled");
  enterFactoryLifecycle(dir, "verify");
  const aggregated = aggregate(
    [...outcome.accepted, ...outcome.failed.map((f) => f.result)],
    outcome.unresolved,
    recorder.finish(usage),
    outcome.failed.map((f) => f.contractId),
  );

  controller.abort();

  const retrospective = buildRetrospective({
    fit: parsed.factoryFit,
    artifacts: aggregated.artifacts,
    unresolved: outcome.unresolved,
    deferred: outcome.deferred.length,
    usage,
    integration: integrationOutcome,
  });
  // Factory ledger — one page (.cubicore-factory-ledger.json) that says
  // what this run decided, what it cost, what it got, and why it wasn't a
  // single agent. The founder can read it later without transcripts.
  try {
    const acceptedCount = outcome.accepted.length;
    const failedCount = outcome.failed.length;
    const deferredCount = outcome.deferred.length;
    const fit = parsed.factoryFit;
    const ledger = {
      retrospective: {
        verdict: retrospective.verdict,
        passed: retrospective.passed,
        flagged: retrospective.flagged,
        deferred: retrospective.deferred,
        totalTokens: retrospective.totalTokens,
      },
      version: 1,
      topology: parsed.topology,
      fit: fit ?? null,
      team: parsed.contracts.length,
      outcome: {
        accepted: acceptedCount,
        failed: failedCount,
        deferred: deferredCount,
      },
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        reasoning: usage.reasoning,
        totalTokens,
        cost: usage.cost,
      },
      decision: fit
        ? `${fit.decision} — ${fit.workers} associates — ${fit.confidence} confidence`
        : 'decision recorded at plan time; ledger merged here',
      integration: integrationOutcome ? {
        command: integrationOutcome.command,
        passed: integrationOutcome.passed,
        output: integrationOutcome.passed ? "" : integrationOutcome.output.slice(0, 600),
      } : null,
      recorded: new Date().toISOString(),
    };
    writeFileSync(`${dir}/.cubicore-factory-ledger.json`, JSON.stringify(ledger, null, 2));

    // Append-only archive. The latest run is a fresh read; every past run
    // stays on disk as history. The ledger used to be overwritten on every
    // execute, which destroyed the audit trail it exists to carry.
    try {
      appendFileSync(`${dir}/.cubicore-factory-history.jsonl`, JSON.stringify(ledger) + "\n");
    enterFactoryLifecycle(dir, "archive", "ledger appended to history.jsonl");
    completeFactoryLifecycle(dir, "run logged and archived");
    } catch {
      // History is a nicety; the latest ledger is the authoritative one.
    }
  } catch {
    // The ledger is an artifact, not a gate. A filesystem error never fails a run.
  }
  const verified = await verifyAndSyncPlan(parsed, dir, validation);
  completeFactoryLifecycle(dir, `verified=${[...verified.progress.values()].filter(v => v === "done").length}/${parsed.contracts.length} on disk`);
  if (integrationOutcome && integrationOutcome.passed === false) {
    enterFactoryLifecycle(dir, "blocked", `integration failed: ${integrationOutcome.output.slice(0, 80)}`);
    verified.failures.push({ contractId: "integration", checkId: parsed.integration!.command.slice(0, 120), output: integrationOutcome.output.trim().slice(0, 600) });
  }
  syncRunRecord(runId, dir, parsed, verified);

  const passedCount = [...verified.progress.values()].filter((state) => state === "done").length;
  const failedCount = [...verified.progress.values()].filter((state) => state === "failed").length;

  return {
    summary: [
      renderRetrospective(retrospective),
      "",
      `${parsed.topology} · ${outcome.accepted.length} passed, ${outcome.failed.length} failed, ` +
        `${outcome.deferred.length} deferred · verified ${passedCount}/${parsed.contracts.length} on disk`,
      ...aggregated.artifacts.map(
        (a) => `- ${a.contractId}: ${a.status}${a.unresolved.length ? ` — ${a.unresolved.join("; ")}` : ""}`,
      ),
      ...(verified.failures.length
        ? [
            "",
            "Disk verification failures:",
            ...verified.failures.slice(0, 2).map(
              (failure) => `- ${failure.checkId}: ${failure.output}`,
            ),
          ]
        : []),
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

  // The plan was written with its factory decision attached (plan_write).
  // Honor it here rather than re-deriving a different answer on the second
  // pass. If the plan says single-agent, dispatch as one associate.
  const effectiveRaw = (() => {
    const fit = parsed.factoryFit;
    if (fit?.decision === "single-agent") {
      return JSON.stringify(synthesizeSingleAgentPlan(parsed));
    }
    return raw;
  })() as string;

  // Validation + dispatch read the synthesized plan. The streaming cap and
  // everything downstream treat this as the actual plan.
  const effectivePlan = parsed.factoryFit?.decision === "single-agent"
    ? synthesizeSingleAgentPlan(parsed)
    : parsed;
  const run = startRun(effectivePlan, dir);
  // Return the verdict in this one call. A Cubicore run is expected to be
  // started and allowed to finish; polling is an extra step the founder
  // should never have to think about.
  try {
    const parent = await resolveParent(parentSessionID);
    const { summary, halted } = await runToCompletion(effectiveRaw, run.id, parent, dir);

    if (halted === "cancelled") {
      cancelRun(run.id, dir, "cancelled by the founder");
    } else if (halted === "paused") {
      pauseRun(run.id, dir);
    } else {
      finishRun(run.id, dir, summary);
    }

    return reply(summary, dir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failRun(run.id, dir, message);
    return text(`Dispatch failed: ${message}`, true);
  }
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

  const run = getRun(runId, where)!;
  const lifecycleLine = factoryLifecycleStatusLine(where);
  return text(`${describe(run)}\n\n${lifecycleLine}`);
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
  const fit = assessFactoryFit({ topology: parsed.topology, contracts: parsed.contracts });
  parsed.factoryFit = fit;
  writeFileSync(`${dir}/.cubicore-factory-fit.json`, JSON.stringify(fit, null, 2));

  // Lifecycle: factory-fit assessment happens next — record it as the project's stage.
  enterFactoryLifecycle(dir, "fit", `topology=${parsed.topology}`);
  if (parsed.topology === "refuse") {
    completeFactoryLifecycle(dir, "refused to split — no team formed");
    return text("This plan refuses to split. That is a valid answer and nothing is written.");
  }

  const problems: string[] = validation.findings.map((f) => `- [${f.code}] ${f.message}`);
  if (topology.cycles.length > 0) {
    problems.push(`- [dependency-cycle] ${topology.cycles.map((c) => c.join(" -> ")).join("; ")}. Not divide-and-conquer.`);
  } else if (!topology.ok) {
    problems.push(`- [mis-declared-topology] declared \`${topology.declared}\`, implies \`${topology.implied}\``);
  }

  // The plan on disk carries the factory-fit decision — execute reads it,
  // and the markdown renders it. Re-serializing the parsed plan is lossless
  // now that parsePlan whitelists factoryFit (design/preview/context ride
  // along the same way).
  writeFileSync(resolved.planPath, JSON.stringify(parsed, null, 2));

  const progress = progressFromDisk(directory, parsed.contracts);
  writeFileSync(
    resolved.mdPath,
    renderPlanMd(parsed, validation, { contracts: progress.contracts, steps: progress.steps }),
  );

  // CUBICORE_CONTEXT.md is for humans who need to present the project in
  // person — hackathon demos, stakeholder reviews, onboarding. It is never
  // parsed by Execute or dispatch.
  if (parsed.context) {
    const contextMdPath = resolved.mdPath.replace("PLAN.md", "CONTEXT.md").replace("PLAN_", "CONTEXT_");
    writeFileSync(contextMdPath, renderContextMd(parsed.context));
  }

  // Lifecycle: plan written and delivered to founder.
  enterFactoryLifecycle(dir, "plan", `contracts=${parsed.contracts.length}`);
  completeFactoryLifecycle(dir, `plan written to CUBICORE_PLAN.json`);

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
      const askedFactory = await askFounderFactoryFit(fit, parsed.contracts.length);
      return text(
        [
          `Plan accepted after ${attempts} attempts, with findings recorded rather than blocking.`,
          "",
          ...problems.map((p) => `- ${p}`),
          "",
          "These are preferences, not safety problems, and the plan was not reworked for them.",
          ...askedFactory,
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

  const askedFactory = await askFounderFactoryFit(fit, parsed.contracts.length);
  return text(
    [
      `Wrote ${PLAN_MD} (for you) and ${PLAN_JSON} (dispatchable).`,
      `Associates: ${parsed.contracts.length}, topology ${parsed.topology}.`,
      "",
      renderFit(fit),
      "",
      "Nothing has run.",
      ...askedFactory,
    ].join("\n"),
  );
}

/**
 * Record the founder's override of the factory-fit recommendation. Rewrites
 * the plan file, the factory-fit record and the founder-facing markdown so
 * what execute runs and what the founder reads stay in agreement. Not needed
 * when the founder accepts the recommendation.
 */
async function recordFactoryFit(
  choice: "team" | "single-agent",
  note: string | undefined,
  planNumber: number | undefined,
  dir: string,
): Promise<ToolResult> {
  const resolved = resolvePlanFile(dir, planNumber);
  let raw: string;
  try {
    raw = await Bun.file(resolved.planPath).text();
  } catch {
    return text(`No plan file found at ${resolved.planPath}. Plan first.`, true);
  }
  let parsed: Plan;
  try {
    parsed = parsePlan(raw) as Plan;
  } catch (error) {
    const problems = error instanceof MalformedPlan ? error.problems : [String(error)];
    return text(["Stored plan did not parse:", ...problems.map((p) => `- ${p}`)].join("\n"), true);
  }
  const contractCount = parsed.contracts.length;
  const current = parsed.factoryFit ?? assessFactoryFit({ topology: parsed.topology, contracts: parsed.contracts });
  const nextFit = applyFounderFactoryChoice(current, contractCount, choice, note);
  const next: Plan = { ...parsed, factoryFit: nextFit };
  writeFileSync(resolved.planPath, JSON.stringify(next, null, 2));
  writeFileSync(`${dir}/.cubicore-factory-fit.json`, JSON.stringify(nextFit, null, 2));
  const validation = validatePlan(next, deriveBaseline(dir));
  const progress = progressFromDisk(dir, next.contracts);
  writeFileSync(
    resolved.mdPath,
    renderPlanMd(next, validation, { contracts: progress.contracts, steps: progress.steps }),
  );
  const tail =
    choice === "single-agent"
      ? "execute will collapse this to a single associate."
      : `execute will run this as written — ${contractCount} associate${contractCount === 1 ? "" : "s"}.`;
  return reply(
    [
      `Recorded: ${nextFit.decision} — ${nextFit.workers} associate${nextFit.workers === 1 ? "" : "s"} (founder ${choice === "single-agent" ? "chose one agent" : `chose the team of ${contractCount}`}).`,
      tail,
    ].join("\n"),
    dir,
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
/** Shared shell-runner for checks; one contract should not get a second dependency setup at the same time. */
async function runCheckedShell(
  command: string,
  directory: string,
  timeoutMs = 180_000,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: nodePathEnv(),
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  const exitCode = await proc.exited;
  return { exitCode, output: `${stdout}\n${stderr}`.trim() };
}

/**
 * Run the plan's integration command against the merged tree.
 *
 * Absent from plans that have nothing to build across the whole product.
 * A timeout is a failure, not an indefinite wait — an integration wave that
 * could only signal success by running forever would teach a factory to hang.
 */
async function runIntegration(
  integration: { command: string; timeoutMs?: number },
  dir: string,
): Promise<{
  readonly command: string;
  readonly passed: boolean;
  readonly output: string;
}> {
  const timeoutMs = Math.min(Math.max(integration.timeoutMs ?? 180_000, 1_000), 900_000);
  const result = await runCheckedShell(integration.command, dir, timeoutMs);
  const passed = result.exitCode === 0;
  return { command: integration.command, passed, output: result.output };
}

const PROGRESS_JSON = ".cubicore-progress.json";

let progressionLock: Promise<void> = Promise.resolve();

/** Serialise the short read-modify-write phase so parallel associates cannot clobber each other. */
async function withProgressionLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = progressionLock;
  let release = () => {};
  progressionLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function readPersistedProgression(directory: string): Record<string, ContractState> {
  try {
    const parsed = JSON.parse(readFileSync(`${directory}/${PROGRESS_JSON}`, "utf8")) as Record<string, unknown>;
    const out: Record<string, ContractState> = {};
    for (const [contractId, state] of Object.entries(parsed)) {
      if (state === "pending" || state === "running" || state === "done" || state === "failed" || state === "skipped") {
        out[contractId] = state;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writePersistedProgression(
  directory: string,
  progress: Map<string, ContractState>,
): void {
  const next = Object.fromEntries(progress);
  const temp = `${directory}/${PROGRESS_JSON}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, `${directory}/${PROGRESS_JSON}`);
}

function renderProgressionPlan(
  parsed: Plan,
  directory: string,
  persisted: Record<string, ContractState>,
): void {
  const contracts = new Map<string, ContractState>();
  for (const contract of parsed.contracts) {
    contracts.set(contract.id, persisted[contract.id] ?? "pending");
  }
  const steps = new Map<string, Map<string, ContractState>>();
  for (const contract of parsed.contracts) {
    if (!contract.steps?.length) continue;
    const map = new Map<string, ContractState>();
    for (const step of contract.steps) map.set(step.id, contracts.get(contract.id) ?? "pending");
    steps.set(contract.id, map);
  }
  writeFileSync(
    `${directory}/${PLAN_MD}`,
    renderPlanMd(parsed, { ok: true, findings: [] }, { contracts, steps }),
  );
}

/**
 * Re-check a plan against the files that actually exist.
 *
 * Inline dispatch happens in the host's own task tool, outside Cubicore's run
 * recorder. Checking again from disk gives the plan a factual status instead of
 * leaving every brief stuck at "not started" after the work is done.
 */
async function refreshPlanProgress(
  parsed: Plan,
  directory: string,
): Promise<{
  progress: Map<string, ContractState>;
  failures: Array<{ contractId: string; checkId: string; output: string }>;
}> {
  const progress = new Map<string, ContractState>();
  const failures: Array<{ contractId: string; checkId: string; output: string }> = [];

  for (const contract of parsed.contracts) {
    const checks = contract.checks.filter((check) =>
      check.gating === "blocking" && check.kind !== "judgment"
    );
    if (checks.length === 0) {
      progress.set(contract.id, "done");
      continue;
    }

    let ok = true;
    for (const check of checks) {
      try {
        const result = await runCheckedShell(check.command, directory);
        if (result.exitCode !== 0) {
          ok = false;
          failures.push({ contractId: contract.id, checkId: check.id, output: result.output.slice(0, 600) });
          break;
        }
      } catch (error) {
        ok = false;
        failures.push({
          contractId: contract.id,
          checkId: check.id,
          output: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    progress.set(contract.id, ok ? "done" : "failed");
  }

  return { progress, failures };
}

/** Prove what is present on disk and sync the plan document with that evidence. */
async function verifyAndSyncPlan(
  parsed: Plan,
  directory: string,
  validation: { ok: boolean; findings: { code: string; message: string }[] },
): Promise<ReturnType<typeof refreshPlanProgress>> {
  const verified = await refreshPlanProgress(parsed, directory);
  const steps = new Map<string, Map<string, ContractState>>();
  for (const contract of parsed.contracts) {
    if (!contract.steps?.length) continue;
    const state = verified.progress.get(contract.id);
    const map = new Map<string, ContractState>();
    for (const step of contract.steps) map.set(step.id, state ?? "pending");
    steps.set(contract.id, map);
  }
  writePersistedProgression(directory, verified.progress);
  writeFileSync(
    `${directory}/${PLAN_MD}`,
    renderPlanMd(parsed, validation, { contracts: verified.progress, steps }),
  );
  return verified;
}

/**
 * Mark one associate's work in the plan. Associates call this when they think
 * their piece is complete; done is accepted only after the contract's blocking
 * checks pass on the current tree.
 */
async function markPlanContract(
  args: { contractId: string; state?: "done" | "failed" | "skipped"; detail?: string; directory?: string; expectedRole?: string },
): Promise<ToolResult> {
  const dir = args.directory ?? process.cwd();
  const state = args.state ?? "done";
  if (!["done", "failed", "skipped"].includes(state)) {
    return text(`Unknown state ${JSON.stringify(state)}. Use done, failed, or skipped.`, true);
  }

  let raw: string;
  try {
    raw = await Bun.file(`${dir}/${PLAN_JSON}`).text();
  } catch {
    return text(`No ${PLAN_JSON} in ${dir}.`, true);
  }

  const loaded = loadPlan(raw);
  if (!loaded.ok) return text(`Refusing to mark: ${loaded.reason}`, true);
  const parsed = loaded.plan;
  const contract = parsed.contracts.find((candidate) => candidate.id === args.contractId);
  if (!contract) return text(`No contract named ${JSON.stringify(args.contractId)} in ${PLAN_JSON}.`, true);

  // If the plan declares a role on the contract, the caller must name it.
  // The association is unverifiable on this host (no event attribution), but
  // the declaration is cheap, and it stops two associates accidentally
  // marking each other's contract without intent. The honest thing to do —
  // not a pretense of enforcement.
  if (contract.role) {
    const declared = typeof args.expectedRole === "string" ? args.expectedRole.trim() : "";
    if (!declared) {
      return text(
        `Refusing to mark: this contract carries a role ("${contract.role.name}"), and the caller did not declare ${contract.role.name} as their own role. ` +
          `A contract without the right handsmark cannot be marked done from the wrong hands.`,
        true,
      );
    }
    if (declared !== contract.role.name) {
      return text(
        `Refusing to mark: expected role ${JSON.stringify(contract.role.name)} for contract ${contract.id}, got ${JSON.stringify(declared)}. ` +
          `The plan assigns this contract to ${contract.role.name}, not to ${declared}.`,
        true,
      );
    }
  }

  let detail = args.detail?.trim() || (state === "done" ? "associate verified its own work" : "associate reported failure");
  if (state === "done") {
    const checks = contract.checks.filter((check) => check.gating === "blocking" && check.kind !== "judgment");
    for (const check of checks) {
      let result: { exitCode: number; output: string };
      try {
        result = await runCheckedShell(check.command, dir);
      } catch (error) {
        result = { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
      }
      if (result.exitCode !== 0) {
        const output = result.output.slice(0, 800);
        await withProgressionLock(async () => {
          const persisted = readPersistedProgression(dir);
          persisted[contract.id] = "failed";
          writePersistedProgression(dir, new Map(Object.entries(persisted)));
          renderProgressionPlan(parsed, dir, persisted);
        });
        return text(
          `Refusing to mark ${contract.id} done: blocking check ${check.id} failed.\n${output}`,
          true,
        );
      }
    }
    detail = `associate marks ${contract.id} done; all ${checks.length} blocking check(s) passed`;
  }

  await withProgressionLock(async () => {
    const persisted = readPersistedProgression(dir);
    persisted[contract.id] = state;
    writePersistedProgression(dir, new Map(Object.entries(persisted)));
    renderProgressionPlan(parsed, dir, persisted);
  });
  return text(`${state === "done" ? "Marked" : state === "failed" ? "Marked failed:" : "Marked skipped:"} ${contract.id} in ${PLAN_MD}. ${detail}`);
}

/** Sync persisted run records and plan progress after the verifier has run. */
function syncRunRecord(
  runId: string,
  directory: string,
  parsed: Plan,
  verified: Awaited<ReturnType<typeof refreshPlanProgress>>,
): void {
  for (const contract of parsed.contracts) {
    const state = verified.progress.get(contract.id) ?? "failed";
    const detail = state === "done"
      ? "verified against blocking checks on disk"
      : verified.failures.find((failure) => failure.contractId === contract.id)?.checkId ?? "verification failed";
    recordProgress(runId, directory, contract.id, state, detail);
    for (const step of contract.steps ?? []) {
      recordProgress(runId, directory, contract.id, state, detail, step.id);
    }
  }
}

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

  const validation = validatePlan(parsed, deriveBaseline(directory));
  if (!validation.ok) {
    return text(
      [`Refusing to continue: the plan no longer validates.`, ...validation.findings.map((finding) => `- [${finding.code}] ${finding.message}`)].join("\n"),
      true,
    );
  }

  // First establish ground truth from the files and blocking checks. The run
  // ledger is useful history, but it may be empty when inline dispatch happened
  // through the host rather than Cubicore's own runner.
  const verified = await verifyAndSyncPlan(parsed, directory, validation);

  const contractProgress = new Map<string, ContractState>(verified.progress);
  const stepProgress = new Map<string, Map<string, ContractState>>();
  for (const contract of parsed.contracts) {
    if (!contract.steps?.length) continue;
    const state = contractProgress.get(contract.id) ?? "failed";
    const map = new Map<string, ContractState>();
    for (const step of contract.steps) map.set(step.id, state);
    stepProgress.set(contract.id, map);
  }
  const satisfied = parsed.contracts
    .filter((contract) => contractProgress.get(contract.id) === "done")
    .map((contract) => contract.id);

  // Contracts that were in-flight ("running") when the run was interrupted
  // should have their worktrees preserved so they resume from where they
  // stopped instead of starting over. Since the verifier works from disk, use
  // its "failed" state as evidence that a contract is not already satisfied;
  // exact session history is not required for correctness.
  const last = loadRuns(directory)[0]; // newest first
  const runningContractIds = last
    ? new Set(last.progress.filter((p) => p.state === "running").map((p) => p.contractId))
    : new Set<string>();

  const stepsProgressRecord = new Map<string, Record<string, ContractState>>();
  for (const [cid, smap] of stepProgress) {
    stepsProgressRecord.set(cid, Object.fromEntries(smap));
  }

  const doneCount = satisfied.length;
  const failedCount = verified.failures.length;
  const remaining = parsed.contracts.length - doneCount;

  if (remaining === 0) {
    return reply(
      [
        `All ${parsed.contracts.length} contract(s) verified against their blocking checks. Nothing to continue.`,
        `Tests pass on disk; the plan document has been synced.`,
      ].join("\n"),
      directory,
    );
  }

  // Continue is exempt from the cycle budget: it resumes interrupted work
  // rather than starting a new fix cycle. We still record the run for
  // history, but do not increment the cycle counter.
  const statePath = `${directory}/.cubicore-cycle.json`;
  const state = readCycleState(statePath);

  const run = startRun(parsed, directory);
  writeCycleState(statePath, state);

  try {
    const parent = await resolveParent(parentSessionID);
    const { summary, halted } = await runToCompletion(raw, run.id, parent, directory, satisfied, runningContractIds, stepsProgressRecord);

    if (halted === "cancelled") {
      cancelRun(run.id, directory, "cancelled by the founder");
    } else if (halted === "paused") {
      pauseRun(run.id, directory);
    } else {
      finishRun(run.id, directory, summary);
    }

    try {
      const updatedRuns = loadRuns(directory);
      const latest = updatedRuns[0];
      const finalContractProgress = latest
        ? new Map(latest.progress.map((p) => [p.contractId, p.state]))
        : new Map<string, ContractState>();
      const finalStepProgress = new Map<string, Map<string, ContractState>>();
      if (latest) {
        for (const p of latest.progress) {
          if (!p.steps) continue;
          const stepMap = new Map<string, ContractState>();
          for (const [stepId, state] of Object.entries(p.steps)) stepMap.set(stepId, state);
          finalStepProgress.set(p.contractId, stepMap);
        }
      }
      writeFileSync(
        resolved.mdPath,
        renderPlanMd(parsed, { ok: true, findings: [] }, { contracts: finalContractProgress, steps: finalStepProgress }),
      );
    } catch {
      // Best-effort refresh; the run result is still valid even if MD refresh fails.
    }

    return reply(
      [`${doneCount} done, ${failedCount} failed, ${remaining} to run.`, summary].join("\n"),
      directory,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failRun(run.id, directory, message);
    return text(`Dispatch failed: ${message}`, true);
  }
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

  // The briefs are useless without somewhere to dispatch them to. The check
  // is advisory only: a browser proxy or an HTML fallback must not turn a
  // host with inline sub-agents into a host that silently uses sessions.
  const runtime = runtimeFromEnv();
  const agent = await agentAvailable(runtime.baseUrl, directory);
  const inlineReady = agent.present;
  if (!inlineReady) {
    process.stderr.write(
      `[cubicore] ${ASSOCIATE_AGENT_ID} dispatch unverified: ` +
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
        ? `Dispatch ALL ${loaded.plan.contracts.length} associates to the \`${ASSOCIATE_AGENT_ID}\` sub-agent, in the SAME tool block, in parallel, at the same time. Give each its own brief's path. Do not wait for one before dispatching the next. Do not dispatch them one at a time.`
        : `NOTE: the host's agent list could not be verified${agent.reason ? `: ${agent.reason}` : ""}. ` +
          `That does not prove inline sub-agents are unavailable. If you have the host's task/sub-agent tool, dispatch ALL ${loaded.plan.contracts.length} associates NOW, in the SAME tool block, in parallel, using \`${ASSOCIATE_AGENT_ID}\` if the host knows it or \`general\` otherwise. ` +
          `Do not wait for one before dispatching the next. One brief each, and do not dispatch them one at a time. Only if the host tool cannot launch them concurrently, call execute and let Cubicore dispatch sessions in parallel instead.`,
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
 * Cubicore optimises for finishing, not for narrating. The founder wants the
 * result, not a play-by-play, so the agent works quietly and speaks when done
 * or genuinely blocked. The ending stays small and concrete.
 */
const ENDING = "Work without narrating. Do not report intermediate steps. " +
  "Ask only when blocked; otherwise decide and proceed. End your reply with the result, " +
  "the next commands as /cubicore: commands -- the recommended one first, then the " +
  "alternatives -- and one line of what each is for. Keep it terse. Do not invent " +
  "steps: the tool reads state on disk and knows what is true. If there is nothing " +
  "left, say so plainly. ";


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
      "Execute the plan and run its associates now. Pass `plan` (inline JSON) or " +
      "`planNumber` (reads CUBICORE_PLAN_N.json from disk); omit both to read " +
      "CUBICORE_PLAN.json. Returns when done — no polling, no progress chatter.",
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
    name: "record_factory_fit",
    description:
      WHEN +
      "Records the founder's answer to the factory-fit question when it overrides the " +
      'recommendation the plan reported. choice "single-agent" collapses the plan into one ' +
      'associate at execute time; choice "team" runs the plan as written. Rewrites the plan ' +
      "file, the factory-fit record and the founder-facing markdown so what execute runs and " +
      "what the founder reads stay in agreement. No need to call this when the founder accepts " +
      "the recommendation; do not call it before the founder answers — it is for overrides.",
    inputSchema: {
      type: "object",
      properties: {
        choice: { type: "string", enum: ["team", "single-agent"], description: "What the founder chose." },
        note: { type: "string", description: "The founder's own words, if they said why (optional)." },
        planNumber: { type: "integer", description: "Numbered plan; omit for the base files." },
        directory: { type: "string", description: "Working directory; defaults to the server's." },
      },
      required: ["choice"],
    },
    handler: async (args: { choice?: string; note?: string; planNumber?: number; directory?: string }) => {
      if (args.choice !== "team" && args.choice !== "single-agent") {
        return text('choice must be "team" or "single-agent".', true);
      }
      return recordFactoryFit(args.choice, args.note, args.planNumber, args.directory ?? process.cwd());
    },
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
      "loose code, 0-day style defects — including dead buttons, dead links, hidden console " +
      "errors, dead flags and broken keys — and keeps fixing and re-checking until clean, " +
      "exercising the delivered thing the way a founder would (web, CLI, TUI, GUI). " +
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
    name: "deploy_stack",
    description:
      WHEN +
      "Creates the second deployment MCQ (after the tier form is answered): asks the founder " +
      "to pick a stack with cost, tradeoffs, and what is annoying about it. Marks one option " +
      "as the recommendation. The form goes to the caller's own session. Call this after the " +
      "founder picks the tier — one question at a time, not both at once. Returns an error " +
      "if the form could not be delivered, so the agent falls back to its question tool.",
    inputSchema: {
      type: "object",
      properties: {
        tier: { type: "string", enum: ["free", "paid", "other"], description: "Tier the founder picked (free or paid; use other only when they truly typed it)." },
      },
      required: ["tier"],
    },
    handler: async (args: { tier?: string }) => {
      const runtime = runtimeFromEnv();
      const sessionID = await findCallerSession(runtime);
      const tier = args.tier ?? "free";
      if (!sessionID) return text("Cannot create the stack form: no caller session was found.", true);
      const kind = await detectProjectKind(runtime.directory);
      const result = await createDeployStackForm(runtime, sessionID, tier, kind);
      if (!result.ok) {
        return text(
          "Stack form delivery FAILED (HTTP " + result.status + ": " + result.body + "). " +
            "Do not claim a form was sent. Ask the same stack question now with your question tool " +
            "using the stack options for " + tier + ", grade " + kind + " — never as plain text.",
        );
      }
      return text(
        "Stack question sent as a form. Wait for the founder's answer — do not re-ask, and do " +
          "not proceed until they pick one.",
      );
    },
  },
  {
    name: "preview",
    description:
      WHEN +
      "Runs the delivered thing and keeps it available, the way the founder would use it. " +
      "Works for web apps (starts the localhost server and verifies it), CLI tools (launches " +
      "and verifies output), TUIs (launches and checks the rendered interface), and GUIs " +
      "(launches and confirms readiness — on a real display it opens on screen; on headless " +
      "hosts it retries under xvfb-run or Nix python3+tkinter and says which). Reads the plan's " +
      "`preview` block and reports exactly what it saw.",
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
    name: "plan_mark",
    description:
      WHEN +
      "Marks one associate's contract in CUBICORE_PLAN.md. Used by associates when they finish their own work: " +
      "`done` is accepted only if every blocking check passes on disk; otherwise the contract is marked failed with the failing check's output.",
    inputSchema: {
      type: "object",
      properties: {
        contractId: { type: "string", description: "Contract id from the plan." },
        state: { type: "string", enum: ["done", "failed", "skipped"], description: "Status to mark. Defaults to done." },
        detail: { type: "string", description: "Short reason or handoff note." },
        directory: { type: "string", description: "Working directory; defaults to the server's." },
        expectedRole: { type: "string", description: "The role you are operating as for this contract (matches contract.role.name when the plan declares one)." },
      },
      required: ["contractId"],
    },
    handler: async (args: { contractId: string; state?: "done" | "failed" | "skipped"; detail?: string; directory?: string; expectedRole?: string }) =>
      markPlanContract(args),
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
      "Returns a run's current state, and the full verdict once it finishes. " +
      "Usually unnecessary: execute returns the verdict itself. Use only to inspect an " +
      "already-running run.",
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
      "Execute a plan. Prefers inline sub-agents so associates run in parallel; " +
      "falls back to Cubicore sessions when the host has none. " +
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
      "Plans how to deploy the project. Asks two questions, one after the other — the tier " +
      "(MCQ) and then the stack with a recommendation (MCQ). Writes the deploy files, and " +
      "explains the manual steps.",
    arguments: [],
  },
  {
    name: "debug",
    description:
      "Review, test, and fix the delivered work until the issues disappear — including " +
      "exercising every interactive surface the founder would use: web click-through with " +
      "console-error capture, CLI invocations, TUI keys, GUI controls. Console errors, dead " +
      "commands, and dead UI are blocking findings. Writes CUBICORE_DEBUG.md. Repeats until " +
      "the same failure no longer reproduces; un-fixable warnings/errors are reported after " +
      "retries.",
    arguments: [],
  },
  {
    name: "preview",
    description:
      "Run the delivered thing and keep it available, the way the founder would use it. " +
      "Works for web apps (localhost server, HTTP verified), CLIs (launched and verified via " +
      "output), TUIs (launched and verified by its rendered interface), and GUIs (launched " +
      "and verified ready, landing on the real display when one is reachable; xvfb-run or Nix " +
      "python3+tkinter otherwise). Leaves it running for the founder to inspect. " +
      "Uses the plan's own preview block.",
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
function renderPlanPrompt(
  title: string,
  decideScope: string,
  request: string,
  extraNote?: string,
  includeContext = true,
): string {
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

**Framework & language:** If the user named a framework or programming language(s) to achieve the build, use only that — recommended is ignored. If the user did not mention any, build with the best *current-trend* stack for this domain and say so — not merely the most popular one from two years ago. Name the chosen combo and a one-sentence reason. Do not ask — decide and state.

**Design (web and UI apps):** If the result is visual, the plan MUST carry a "design" block (direction, palette of 2–4 hex colors with the accent last, typeface, notDoing, ambition: calm | standard | bold). Pick a direction by NAME, not by guesswork — "editorial porcelain", "dark editorial", "terminal-first monospace", "maximalist pop", "hand-drawn warmth", or a SPECIFIC invented direction with a name you would defend. Never fall back to "rounded corners, system font, blue accent" — that is the failure mode, not the default. If the founder named a style (glassmorphism, cute, retro, dark), use exactly that and do not override. If they did not, propose ONE direction and ask "Direction: <specific pick> — good?" If "anything", take your proposal. Palette: 2–4 hex colors, accent last. Typeface: one strong face or one confident pairing from the matching direction. notDoing: 3 short prohibitions. ambition: "bold" for marketing pages/portfolio/brand tools, "standard" for product UIs, "calm" for dashboards — never lower than the founder's known bar.

**Opinion:** Before writing the plan, think like a professional who just got this brief and fill in what the user did not say. Write ONE short paragraph (max two sentences, ~400 characters) as the plan's "opinion" field in the JSON: what the requested thing really is today, what an experienced builder would include by default, what you deliberately leave out, and why. Keep it honest — if the user's instinct is right for the problem, say so; do not invent sophistication. Do not widen or narrow the product; just state the best honest full version as it would be done properly *now*. If you would recommend a framework over what's listed, it goes in the plan (never the reply).

**User request:** ${request}${extraNote}

**2. Write the plan.** Build exactly what the user requested above. Do not
substitute, upgrade, or replace it with a project of your own choosing. Then
produce the plan JSON and pass it to the plan tool, which writes
CUBICORE_PLAN.md for the founder, CUBICORE_PLAN.json for the dispatcher, and
CUBICORE_CONTEXT.md for team members who need to present the project in person.
The plan tool also prints the factory-fit decision — the recommended team
size, topology and why — and on an accepted plan it sends the founder the
factory-fit question as an opencode form, the same mechanism as the deploy
questions. In your reply, relay that decision verbatim (not reworded), then
stop. Do not ask the question in plain text, and do not re-ask it — the form
is the question. Do not dispatch — do not call /cubicore:execute — until the
founder answers. If the answer overrides the recommendation (single agent
when a team was recommended, or a team when one agent was recommended), call
record_factory_fit with their choice before anything else; it rewrites the
plan file, the factory-fit record and the markdown so execute runs what the
founder chose. If they accept the recommendation, or just say "yes", stop and
let them run /cubicore:execute next.

Prefer \`fan-out\` whenever write scopes are disjoint. A \`reads\` entry usually
means the checks depend on the files, not that the worker must wait to write its
own files. Use \`pipeline\` only when the second contract cannot produce any
usable deliverable until the first returns; otherwise create shared interfaces,
placeholders, or loose contracts and dispatch them simultaneously.

The plan needs:
- A \`summary\` field — one or two sentences describing what this project is,
  shown at the top of CUBICORE_PLAN.md so the founder understands the product
  at a glance.${includeContext ? `
- A \`context\` field only if the founder asked for a pitch, business case, or
  team-handoff document. Never invent market sizing, GTM, TAM, competition,
  risks or fundraising detail. If included, keep every required field to one
  short line; otherwise omit it entirely.` : ""}
- \`graphBudget.nodes\` at least the number of contracts.
- \`graphBudget.edges\` at least the read/write dependencies between contracts.
- If the result can be started, served, or launched — a web app's localhost server, a CLI tool,
  a TUI, or a GUI — include a top-level \`preview\` object with the command, and any
  URL/readyLine/outputContains/expectation needed to know it came up. Omit it only for a
  library or report with nothing to interactively run.
- For a GUI on a headless host, prefer a preview command that can survive it: e.g., a Nix
  expression providing the GUI toolkit and an X server (xvfb-run), or a ready line/expectation
  the command can satisfy — the preview tool will retry bare commands under xvfb-run or a
  matching Nix environment when the first attempt is a native-module or display failure.

Every contract needs:
- A \`schema\` field describing its output
- At least one check that \`can fail\`
- Disjoint \`writes\` from every other contract
- Optionally a \`role\` object: { name, capabilities, tools?, handoff?, exclusions?, escalation?, budget? } — exact authority, not a job title. A plan with roles is preferred for anything non-trivial; if you use them, use them fully — name is required, an empty capability list is a lie.

Plan JSON must match the schema below, but the OUTPUT must NOT include "$schema", "type", "required", or "additionalProperties" fields — those are validator metadata only. Every contract must have exactly: id, objective, reads, writes, forbidden, deliverable, schema, doneWhen, checks, budget; optionally role (a fully-populated one — see "Every contract needs"). No other fields (no "preview", no "$schema").

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
    "contract that installs its dependencies (npm, pip, cargo, apt, brew, etc.). " +
    "Keep the plan compact: omit the `context` field; use a one-sentence summary and " +
    "only the checks needed to catch real defects. DO NOT make scaffold output a " +
    "dependency just because the app uses it: app contracts may rely on the scaffold spec " +
    "in the plan and should be written in the same wave. Use `pipeline` only for a real " +
    "serial handoff. If the app needs a package file or entry point for its final checks, " +
    "add an integration contract that runs after both contracts and gates the build.";
}

/** Builds the enterprise decide-scope section. */
function planFullScope(): string {
  return "This is a full product from scratch. Build exactly what the " +
    "founder requested. Do not choose your own project idea and do not substitute a " +
    "different product. Include only the endpoints, config, observability, CI/CD and " +
    "error handling the requested product actually needs; do not invent enterprise " +
    "features the founder did not ask for. Split the build into disjoint contracts and " +
    "prefer `fan-out`: workers should be dispatched at the same time whenever their " +
    "writes are disjoint. Do NOT put scaffold output in `reads` just to implement against " +
    "it — write the application against the agreed interface, and add an integration " +
    "contract or integration wave for the final build. Use `pipeline` only when a worker " +
    "cannot produce anything useful until an earlier contract returns. If the request " +
    "names a framework or tool, include an installation contract that installs its " +
    "dependencies (npm, pip, cargo, apt, brew, etc.) in the same wave wherever safe. " +
    "Aim for at most two dependency waves; long pipelines are a symptom of bad splitting, not a virtue. " +
    "Do not create narrative market content by default. Either omit `context`, or keep every required field to a short line if context is genuinely required. " +
    "If the product can be built, typechecked, or boot-tested across the whole tree, include a top-level " +
    "\"integration\" object with { command, timeoutMs? }: the build command, the typecheck, the merged test suite. " +
    "The factory runs it after verification; the run is not done until it also passes. " +
    "If there is nothing to test as a whole, omit it.";
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
              existingPlan ? "\n\nNOTE: A plan already exists at CUBICORE_PLAN.json. If the founder wants to change or add a feature to the existing project, use `/cubicore:refine` instead of `/cubicore:plan-demo`. Only proceed with a new plan here if the founder explicitly confirms they want to start over." : "",
              false
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
      description: "Execute the plan and speak when done.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
`${ENDING}Execute CUBICORE_PLAN.json now. Do not explain the plan to the founder; dispatch it.

Default: read CUBICORE_PLAN.json. If absent, CUBICORE_PLAN_1.json. Pass planNumber for CUBICORE_PLAN_N.json.

1. Call \`dispatch_blueprint\` with the project kind.
2. Dispatch ALL associates to \`${ASSOCIATE_AGENT_ID}\`, or the host's available sub-agent tool, in the SAME tool block, in parallel, at the same time. Do not dispatch one at a time or wait for one before dispatching the next. One brief each. Do not implement the work yourself before they return. If the host tool cannot launch them concurrently, call \`execute\` instead so Cubicore dispatches sessions in parallel.
3. Wait for every report separately. Never merge them.
4. Run every blocking check and fix failures in a tight loop. Record results with the debug tool.
5. Leave the delivered thing running if it is runnable, and reply only with the outcome, any blockers, and the next commands.

If this host truly has no sub-agent tool, call \`execute\` instead and let Cubicore dispatch sessions itself.`,
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

**Team size override.** If the founder says "single agent", "do it as one", or similar, do
NOT split the work. Collapse the plan to ONE contract whose write scope is the union of the
existing ones (or the whole tree if it is a greenfield ask), keep every check, and set the
topology to single-agent-compatible. If the founder says "split it into 3" or the like, divide
across disjoint scopes accordingly — the same single contract, three writers, disjoint writes.

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

**1. What tier?** Ask the founder with your question tool (MCQ, never plain text).
Options, exactly:
- "Free tier ($0)" — No hosting cost; distribution via free channels (e.g. GitHub releases, source or bundled binary).
- "Paid tier" — Budget for hosting/signing/distribution tooling (certificates, cloud storage/CDN, CI minutes, etc.).
- "Other" — Something else — type it.
Wait for the answer. Do not pick a tier yourself, and do not ask about stacks until they have answered.

**2. Once the founder picks a tier, call the deploy_stack tool with that tier.** A second
MCQ form will appear with 3–4 real stacks for that tier, each with what it costs, what it gives
up, and what is annoying about it, and one marked as my recommendation. Wait for the answer.
Do not list the stacks yourself, do not offer other options, and do not proceed until they pick one.

If the deploy_stack tool returned an error, or the form did not appear, or you did not call the
tool at all: ask the stack question yourself with your question tool (MCQ, never plain text),
using the exact options for the tier and project kind below:

Desktop GUI / CLI / TUI app (e.g. Python + Tkinter, no backend):
- "GitHub Releases (recommended)" — $0 · signed assets + install notes per OS · auto-update is manual · annoying: churn at release time
- "Source zip + install script" — $0 · anyone with Python runs it · annoying: users must install Python and tkinter themselves
- "PyInstaller bundled binary" — ~$0 · works without a Python install · ~40MB downloads · annoying: OS-specific builds, slower startup
- "Flatpak (Linux)" — $0 · sandboxed Linux install · annoying: needs Flatpak setup, and the app's filesystem access needs explicit permissions
- "Other" — specify your own distribution, constraint, or platform

Web app, free tier:
- "Static host (recommended)" — $0 · zero-config · you serve dist/ with npx serve yourself · annoying: no CI — you rebuild by hand on every deploy
- "Cloudflare Pages" — $0 · git-push CI · custom domain + HTTPS free · annoying: requires a GitHub repo and a build command
- "GitHub Pages" — $0 · git-push CI · annoying: needs a public repo (or GitHub Pro), slower CDN than Cloudflare
- "Other" — specify your own stack, constraint, or platform

Web app, paid tier:
- "Railway (recommended)" — ~$5/mo baseline · one buildpack · managed Postgres + custom domains · weakest: you ride their pricing changes
- "Fly.io" — $0–few $/mo for tiny apps · Docker-native · annoying: registry auth + fly.toml by hand
- "Render" — $0 trial · $7/mo static · $19+/mo services · git deploy · slower cold start than Railway
- "Other" — specify your own stack, constraint, or platform

Tailor the question text to the actual project (include its name and stack, e.g. "How should this desktop GUI app (Python + Tkinter, no backend) be deployed — what stack?"). That is one question. No double questions in one turn. No plain-text MCQ lists — the founder must see picks, not paragraphs.

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
`${ENDING}Call the status tool with the run id, and use one generous waitMs if you must wait.

Execute normally returns the verdict itself, so do not poll in a loop. If it is still running, say so and report the elapsed time. If it is done, report the pass/fail counts and any blockers.`,
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
`${ENDING}Run the preview tool. It launches what the plan says to launch, exactly the way the
founder will use it, and keeps it available.

The plan's preview block is the founder's own statement of what working looks like — the command,
the ready line, how long to wait, and what it can verify:

- Web app — starts the localhost server the founder opens, and verifies it with an HTTP request:
  status, and a body substring when given.
- CLI tool — launches the tool and verifies what it prints (or that it stays up, for daemons):
  exit output matched against outputContains, or the ready line from the plan.
- TUI — launches it in a terminal and confirms it rendered and is waiting for input.
- GUI — launches it and confirms it reached readiness. On a display-reachable host it lands on
  that display (a Nix python with tkinter is used when the system one lacks it); otherwise it
  retries under xvfb-run or a Nix environment providing the GUI toolkit, and says which one used.

If there is no preview block, say so plainly. A library or a report has nothing to launch, and that
is a correct plan, not a failure. Do not invent something to run.

If it fails, report the actual output rather than a summary of it. The founder is finding out
whether this works, and "it did not start" is only useful with the reason attached — and when the
blocker is the environment (missing tkinter, headless), name that plainly and say what would fix it.`,
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

2. Interact with the delivered thing — the step agents forget. Use it the way the
   founder would, per platform:
   - Web app: open it in a real browser (use the opencode browser tool if this
     environment has it, otherwise Playwright). Click through EVERY interactive
     element, once each, in order — every button, link, tab, form, and input,
     plus the initial page load. Read the browser's console. Any console error,
     uncaught exception, or failed network request (4xx/5xx) is a blocking
     "error" finding, not a warning — do not claim the app is fixed until the
     console is clean. A button that renders but does nothing is one of these.
   - CLI tool: run every documented subcommand, flag, and positional argument at
     least once (and --help and the no-argument case). Check each invocation
     exits with the documented code and that stderr is clean. A flag that does
     nothing is the same fault as a dead button.
   - TUI: launch it, verify the interface renders, and exercise its keys
     (arrows, Enter, Tab, q or Ctrl-C to quit). Check the terminal output for
     errors — garbage rendering counts as an error finding.
   - GUI: launch it and click through every menu, button, checkbox, and input
     once. Check stderr and any logs it writes on exit.
   - Library or report with no interactive surface: say so plainly — coverage
     here rests on the mechanical checks, not this step.
   "Does not crash" is not a pass — every interactive element must actually work.

3. Run the mechanical check matrix and the baseline checks.

4. For each real failure, turn it into a narrowly-scoped fix contract, dispatch it, and
   re-run the check that caught it. After every fix, exercise the surface again the
   same way it was tested above — a fix that breaks a different button, flag, or key
   is a new error.

5. Repeat until the same failure no longer reproduces and no errors are found in another pass through the delivered thing.

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
              const result = await createDeployTierForm(runtime, sessionID);
              if (!result.ok) {
                process.stderr.write(`[cubicore deploy] tier form delivery failed: HTTP ${result.status} ${result.body}\n`);
              }
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
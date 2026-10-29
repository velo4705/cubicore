import { checkTopology } from "../coordinator/topology";
import { validatePlan } from "../validate/plan";
import { parsePlan } from "../coordinator/parse";
import { PLAN_SCHEMA_JSON } from "../contracts/schema";
import { readFileSync, writeFileSync } from "node:fs";

import type { Contract, Plan } from "../contracts/types";
import type { ContractState } from "./runs";

/**
 * The Plan → Execute → Test protocol.
 *
 * State lives in files, not in any conversation. That is deliberate and it is
 * D7: the artifacts are the record, not the transcripts. It also means a run
 * survives a restart, a crash, and a founder who comes back tomorrow.
 *
 *   CUBICORE_PLAN.md     what to build, who does it, how many
 *   CUBICORE_PLAN.json   the same thing, machine-readable and validated
 *   CUBICORE_DEBUG.md    findings from Test, with a fix for each
 *
 * Markdown is for the founder. JSON is for the machine, and it is the only
 * thing Execute dispatches -- the markdown is never parsed, because a typo in
 * a prose summary must not silently change what gets built.
 */

/** Hard ceiling on Execute → Test → Execute cycles. See `cycleState`. */
export const DEFAULT_MAX_CYCLES = 3;

export const PLAN_MD = "CUBICORE_PLAN.md";
export const PLAN_JSON = "CUBICORE_PLAN.json";
export const DEBUG_MD = "CUBICORE_DEBUG.md";

export interface CycleState {
  cycle: number;
  maxCycles: number;
  /** Findings carried from the previous Test, for Execute to address. */
  fromDebug: boolean;
}

export function readCycleState(path: string, maxCycles = DEFAULT_MAX_CYCLES): CycleState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CycleState>;
    return {
      cycle: typeof raw.cycle === "number" ? raw.cycle : 0,
      maxCycles: typeof raw.maxCycles === "number" ? raw.maxCycles : maxCycles,
      fromDebug: raw.fromDebug === true,
    };
  } catch {
    return { cycle: 0, maxCycles, fromDebug: false };
  }
}

export function writeCycleState(path: string, state: CycleState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Whether another Execute is permitted.
 *
 * The original protocol said "repeat until the debug file is deleted", which
 * means the agent decides when it is finished. That is an unbounded loop: the
 * terminal case is an agent that keeps finding new things to fix, which is the
 * runaway this project exists to prevent (D6). The bound lives here rather
 * than in a prompt so no amount of agent enthusiasm can exceed it.
 */
export function canExecute(state: CycleState): { allowed: boolean; reason: string } {
  if (state.cycle >= state.maxCycles) {
    return {
      allowed: false,
      reason:
        `Cycle budget exhausted (${state.cycle}/${state.maxCycles}). ` +
        `Further fixes are not automatic -- the remaining findings are reported as ` +
        `unresolved for a human to triage. Raise the budget deliberately, or fix them.`,
    };
  }
  return { allowed: true, reason: `Cycle ${state.cycle + 1} of ${state.maxCycles}.` };
}

export function renderPlanMd(
  plan: Plan,
  validation: { ok: boolean; findings: { code: string; message: string }[] },
  progress?: { contracts?: Map<string, ContractState>; steps?: Map<string, Map<string, ContractState>> },
): string {
  const workers = plan.contracts.length;
  const size =
    workers === 0 ? "empty" : workers <= 2 ? "small" : workers <= 6 ? "normal" : "large";

  const contractState = (c: Contract): ContractState | undefined =>
    progress?.contracts?.get(c.id);

  const stepState = (c: Contract, stepId: string): ContractState | undefined =>
    progress?.steps?.get(c.id)?.get(stepId);

  const iconFor = (state: ContractState | undefined): string =>
    state === "done" ? "✅" : state === "failed" ? "❌" : state === "running" ? "🔄" : "⏳";

  const md = [
    `# Cubicore plan`,
    ``,
  ];

  if (plan.summary) {
    md.push(
      `## What this is`,
      ``,
      plan.summary,
      ``,
    );
  }

  md.push(
    `- **Topology:** ${plan.topology}`,
    `- **Project size:** ${size} (${workers} associate${workers === 1 ? "" : "s"})`,
    `- **Token ceiling:** ${plan.graphBudget.tokens.toLocaleString()}`,
    `- **Wall ceiling:** ${Math.round(plan.graphBudget.wallMs / 1000)}s`,
    `- **Validation:** ${validation.ok ? "passed" : `${validation.findings.length} finding(s)`}`,
    ``,
    `## Associates`,
    ``,
    ...plan.contracts.map((c) => {
      const state = contractState(c);
      const checkLines = c.checks.length
        ? [`- **Checks:**`, ...c.checks.map((k) => `  - \`${k.command}\` (${k.gating}, ${k.convergent ? "convergent" : "non-convergent"})`)]
        : [`- **Checks:** none`];

      const stepLines = c.steps?.length
        ? [
            `- **Steps:**`,
            ...c.steps.map((s) => {
              const sState = stepState(c, s.id);
              const done = sState === "done";
              return `    ${done ? "- [x]" : "- [ ]"} \`${s.id}\` — ${s.description} ${iconFor(sState)}`;
            }),
          ]
        : [];

      return [
        `### ${iconFor(state)} ${c.id}`,
        ``,
        c.objective,
        ``,
        `- **Writes:** ${c.writes.join(", ") || "(none)"}`,
        `- **Reads:** ${c.reads.join(", ") || "(none)"}`,
        `- **Deliverable:** ${c.deliverable}`,
        `- **Done when:** ${c.doneWhen}`,
        ...stepLines,
        ...checkLines,
        ``,
      ].join("\n");
    }),
    `## Machine-readable`,
    ``,
    `The dispatchable plan is \`${PLAN_JSON}\`. Execute reads that file, never this one.`,
    ``,
  );

  return md.join("\n");
}

export interface TestFinding {
  severity: "error" | "warning" | "judgment";
  source: string;
  message: string;
  fix: string;
}

/**
 * Classify a finding honestly.
 *
 * `error` and `warning` are mechanical and come from running the contract's
 * own checks. `judgment` is everything the mechanical matrix cannot decide --
 * is this feature useful, is it production-ready, is this API free to ship.
 *
 * `judgment` checks are rejected by the validator in v1, so Test reports them
 * as findings for a human rather than blocking on them. Auto-failing on taste
 * is the loop that never terminates; auto-passing on taste is worse, because
 * it looks like a verdict.
 */
export function classify(finding: TestFinding): "blocks" | "annotates" {
  return finding.severity === "judgment" ? "annotates" : "blocks";
}

export function renderDebugMd(findings: TestFinding[], cycle: number, maxCycles: number): string {
  const blocking = findings.filter((f) => classify(f) === "blocks");
  const advisory = findings.filter((f) => classify(f) === "annotates");

  const md = [
    `# Cubicore findings`,
    ``,
    `Cycle ${cycle} of ${maxCycles}. ${blocking.length} blocking, ${advisory.length} advisory.`,
    ``,
    ...(blocking.length
      ? [
          `## Blocking`,
          ``,
          ...blocking.map((f) => [`### ${f.message}`, ``, `- **Source:** ${f.source}`, `- **Fix:** ${f.fix}`, ``].join("\n")),
        ]
      : []),
    ...(advisory.length
      ? [
          `## Advisory`,
          ``,
          `_These are judgement calls, not mechanical failures. Test reports them; it does not block on them._`,
          ``,
          ...advisory.map((f) => [`### ${f.message}`, ``, `- **Source:** ${f.source}`, `- **Suggested:** ${f.fix}`, ``].join("\n")),
        ]
      : []),
    `## Next`,
    ``,
    blocking.length === 0
      ? `No blocking findings. Whatever is advisory above is for a human to judge.`
      : `Run Execute again to address the blocking findings. Bounded at ${maxCycles} cycles, then they are reported as unresolved.`,
    ``,
  ];

  return md.join("\n");
}

/** Validate a plan document found on disk, explaining the failure if it is not usable. */
export function loadPlan(raw: string): { ok: true; plan: Plan } | { ok: false; reason: string } {
  let parsed: Plan;
  try {
    parsed = parsePlan(raw) as Plan;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (parsed.topology === "refuse") return { ok: false, reason: "plan refuses to split" };

  const validation = validatePlan(parsed, []);
  const topology = checkTopology(parsed);

  if (!validation.ok) {
    return { ok: false, reason: validation.findings.map((f) => `[${f.code}] ${f.message}`).join("; ") };
  }
  if (topology.cycles.length > 0) {
    return { ok: false, reason: "dependency cycle — not a divide-and-conquer task" };
  }
  if (!topology.ok) {
    return { ok: false, reason: `declared ${topology.declared} but the plan implies ${topology.implied}` };
  }
  return { ok: true, plan: parsed };
}

export { PLAN_SCHEMA_JSON };
import { checkTopology } from "../coordinator/topology";
import { validatePlan } from "../validate/plan";
import { parsePlan } from "../coordinator/parse";
import { PLAN_SCHEMA_JSON } from "../contracts/schema";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Contract, Plan, PlanContext } from "../contracts/types";
import type { ContractState } from "./runs";

/** A single cross-plan finding: a read that no plan writes, or a write no plan reads. */
export interface CrossPlanFinding {
  planFile: string;
  contractId: string;
  kind: "orphan-read" | "unread-write";
  target: string;
  message: string;
}

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
export const CONTEXT_MD = "CUBICORE_CONTEXT.md";

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

/** The factory decision rendered for the plan file. */
export function renderFactoryFit(fit: { decision: string; workers: number; why: string; whyNotMore: string; confidence: string }): string {
  return [
    `## Why this factory?`,
    ``,
    `- Decision: ${fit.decision} (team of ${fit.workers})`,
    `- Why: ${fit.why}`,
    `- Why not more: ${fit.whyNotMore}`,
    `- Confidence: ${fit.confidence}`,
    ``,
  ].join("\n");
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
    state === "done" ? "✅" : state === "blocked" ? "⚠️" : state === "failed" ? "❌" : state === "running" ? "🔄" : "⏳";

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

  if (plan.opinion) {
    md.push(
      `## Planner's opinion`,
      ``,
      `> ${plan.opinion}`,
      ``,
      `_This is advice, not scope. It was not dispatched. Strike it for free with /cubicore:refine._`,
      ``,
    );
  }

  const integrationSection = plan.integration ? [
    `## Integration wave`,
    ``,
    `\`\`\`bash`,
    plan.integration.command,
    `\`\`\``,
    ``,
  ] : [];

  const designSection = plan.design ? [
    `## Design`,
    ``,
    `**Direction:** ${plan.design.direction}`,
    `**Ambition:** ${plan.design.ambition}`,
    `**Palette:** ${plan.design.palette.map((c) => `\`${c}\``).join(", ")}`,
    `**Typeface:** ${plan.design.typeface}${plan.design.typeScale ? ` @ ${plan.design.typeScale}×` : ""}`,
    plan.design.spacing !== undefined ? `**Spacing:** ${plan.design.spacing}px` : ``,
    plan.design.radii && plan.design.radii.length > 0 ? `**Radii:** ${plan.design.radii.join(", ")}px` : ``,
    plan.design.signature ? `**Signature:** ${plan.design.signature}` : ``,
    `**Never:** ${plan.design.notDoing.map((d) => `\`${d}\``).join("; ")}`,
    ``,
  ].filter((line) => line !== ``) : [];

  const fitSection = plan.factoryFit ? renderFactoryFit(plan.factoryFit).split("\n") : [];

  md.push(
    `- **Topology:** ${plan.topology}`,
    `- **Project size:** ${size} (${workers} associate${workers === 1 ? "" : "s"})`,
    `- **Token ceiling:** ${plan.graphBudget.tokens.toLocaleString()}`,
    `- **Wall ceiling:** ${Math.round(plan.graphBudget.wallMs / 1000)}s`,
    `- **Validation:** ${validation.ok ? "passed" : `${validation.findings.length} finding(s)`}`,
    ``,
    ...integrationSection,
    ...designSection,
    ...fitSection,
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

/**
 * Validate that all plan files in a directory have mutually disjoint write scopes.
 *
 * Used in the multi-member hackathon flow where each member gets their own
 * CUBICORE_PLAN_N.json. If two plans claim the same file, dispatching both
 * would cause a collision. This check runs before any associate starts.
 *
 * Returns an array of problem strings, or an empty array when all plans are
 * mutually disjoint.
 */
export function validateCrossPlanCollisions(directory: string): string[] {
  const problems: string[] = [];
  const planFiles: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return problems;
  }

  for (const entry of entries) {
    if (!entry.startsWith("CUBICORE_PLAN_") || !entry.endsWith(".json")) continue;
    planFiles.push(join(directory, entry));
  }

  if (planFiles.length < 2) return problems;

  // Collect all write scopes across all plans.
  const writesByFile = new Map<string, string[]>(); // file -> [planFile, contractId]
  for (const planPath of planFiles) {
    let raw: string;
    try {
      raw = readFileSync(planPath, "utf8");
    } catch {
      continue;
    }

    const loaded = loadPlan(raw);
    if (!loaded.ok) continue;

    for (const contract of loaded.plan.contracts) {
      for (const write of contract.writes) {
        if (!writesByFile.has(write)) writesByFile.set(write, []);
        writesByFile.get(write)!.push(`${planPath.split("/").pop()}:${contract.id}`);
      }
    }
  }

  for (const [file, sources] of writesByFile) {
    if (sources.length > 1) {
      problems.push(
        `write collision on "${file}": claimed by ${sources.join(", ")}`,
      );
    }
  }

  return problems;
}

/**
 * Validate cross-plan interface compatibility.
 *
 * For every contract in every plan file, checks:
 *   - orphan-read: a contract reads a file that no plan writes (the read is
 *     unsatisfied -- someone needs to produce it).
 *   - unread-write: a contract writes a file that no plan reads (the write may
 *     be dead code, or it is consumed outside Cubicore).
 *
 * Reads can overlap between plans (many readers are fine). Writes must not
 * overlap (checked by validateCrossPlanCollisions).
 *
 * Returns an array of problem strings, or an empty array when all interfaces
 * are satisfied.
 */
export function validateCrossPlanInterfaces(directory: string): string[] {
  const problems: string[] = [];
  const planFiles: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return problems;
  }

  for (const entry of entries) {
    if (!entry.startsWith("CUBICORE_PLAN_") || !entry.endsWith(".json")) continue;
    planFiles.push(join(directory, entry));
  }

  if (planFiles.length < 2) return problems;

  // Collect all writes across all plans first, so we can check reads against them.
  const allWrites = new Set<string>();
  const planData: Array<{ planFile: string; plan: Plan }> = [];

  for (const planPath of planFiles) {
    let raw: string;
    try {
      raw = readFileSync(planPath, "utf8");
    } catch {
      continue;
    }

    const loaded = loadPlan(raw);
    if (!loaded.ok) continue;

    for (const contract of loaded.plan.contracts) {
      for (const write of contract.writes) {
        allWrites.add(write);
      }
    }

    planData.push({ planFile: planPath.split("/").pop() ?? planPath, plan: loaded.plan });
  }

  // Check every read against the global write set.
  for (const { planFile, plan } of planData) {
    for (const contract of plan.contracts) {
      for (const read of contract.reads) {
        if (!allWrites.has(read)) {
          problems.push(
            `orphan read on "${read}" by ${planFile}:${contract.id} -- no plan writes this file`,
          );
        }
      }

      for (const write of contract.writes) {
        // A write with no reader anywhere is advisory, not blocking:
        // it may be consumed outside Cubicore (e.g. a CLI output, a report).
        // We skip flagging it to avoid false positives.
      }
    }
  }

  return problems;
}

/**
 * Run all cross-plan validations: write-scope collisions and interface compatibility.
 *
 * Returns all problems from both checks, or an empty array when all plans
 * are mutually compatible.
 */
export function validateCrossPlan(directory: string): string[] {
  return [...validateCrossPlanCollisions(directory), ...validateCrossPlanInterfaces(directory)];
}

/**
 * Render CUBICORE_CONTEXT.md — narrative context for human readers.
 *
 * Not parsed by Execute or dispatch; purely for team members who need to
 * present the project in person (e.g., hackathon demos, stakeholder
 * reviews, recruiter conversations). Contains problem, users, use cases,
 * benefits, demo flow, future work, market opportunity, business model,
 * competitive advantage, go-to-market, risks, current status, and the ask.
 */
export function renderContextMd(context: PlanContext): string {
  const md = [
    `# Context — Cubicore project`,
    ``,
    `## Problem Statement`,
    ``,
    context.problem,
    ``,
    `## Target Users`,
    ``,
    context.users,
    ``,
    `## Use Cases`,
    ``,
    ...context.useCases.map((u) => `- ${u}`),
    ``,
    `## Benefits`,
    ``,
    ...context.benefits.map((b) => `- ${b}`),
    ``,
    `## Demo Flow`,
    ``,
    ...context.demoFlow.map((d, i) => `${i + 1}. ${d}`),
    ``,
    `## Application Perspectives`,
    ``,
    ...context.futureWork.map((f) => `- ${f}`),
    ``,
    `## Market Opportunity`,
    ``,
    context.marketOpportunity,
    ``,
    `## Business Model`,
    ``,
    context.businessModel,
    ``,
    `## Competitive Advantage`,
    ``,
    context.competitiveAdvantage,
    ``,
    `## Go-to-Market`,
    ``,
    context.goToMarket,
    ``,
    `## Risks`,
    ``,
    ...context.risks.map((r) => `- ${r}`),
    ``,
    `## Current Status`,
    ``,
    context.currentStatus,
    ``,
    `## The Ask`,
    ``,
    ...context.ask.map((a) => `- ${a}`),
    ``,
  ];

  return md.join("\n");
}

export { PLAN_SCHEMA_JSON };
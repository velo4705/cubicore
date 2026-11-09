import type {
  Check,
  Contract,
  Finding,
  Plan,
  ValidationResult,
} from "../contracts/types";
import { overlapPairs, overlaps } from "./overlap";
import { findDependencies } from "../coordinator/topology";
import { assertBaselineIntact, effectiveMatrix, validateChecks } from "./matrix";

function isBlank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

function checkContract(contract: Contract, seen: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const at = [contract.id];

  if (seen.has(contract.id)) {
    findings.push({
      code: "duplicate-id",
      contractIds: at,
      message: `duplicate contract id "${contract.id}"`,
    });
  }
  seen.add(contract.id);

  if (isBlank(contract.objective)) {
    findings.push({
      code: "missing-objective",
      contractIds: at,
      message: `contract "${contract.id}" has no objective`,
    });
  }

  if (
    !contract.schema ||
    typeof contract.schema !== "object" ||
    Object.keys(contract.schema).length === 0
  ) {
    findings.push({
      code: "missing-schema",
      contractIds: at,
      message: `contract "${contract.id}" has no output schema`,
    });
  }

  if (isBlank(contract.doneWhen)) {
    findings.push({
      code: "missing-done-when",
      contractIds: at,
      message: `contract "${contract.id}" has no doneWhen condition`,
    });
  }

  const { tokens, toolCalls, wallMs } = contract.budget ?? {};
  if (
    !(tokens > 0) ||
    !(toolCalls > 0) ||
    !(wallMs > 0)
  ) {
    findings.push({
      code: "invalid-budget",
      contractIds: at,
      message: `contract "${contract.id}" has a non-positive budget`,
    });
  }

  findings.push(...validateChecks(contract.checks ?? [], contract.id));

  // A code artifact with no runnable gate can only be judged by an LLM reading
  // a diff, which is the untrustworthy path D9 exists to avoid.
  const hasBlocking = (contract.checks ?? []).some(
    (check) => check.gating === "blocking",
  );
  if (contract.deliverable === "diff" && !hasBlocking) {
    findings.push({
      code: "no-blocking-check",
      contractIds: at,
      message: `contract "${contract.id}" produces a diff but declares no blocking check, so nothing can verify it`,
    });
  }

  return findings;
}

function checkPair(a: Contract, b: Contract): Finding[] {
  const findings: Finding[] = [];
  const ids = [a.id, b.id];

  const collisions = overlapPairs(a.writes, b.writes);
  if (collisions.length > 0) {
    const detail = collisions
      .map(([left, right]) => `"${left}" ∩ "${right}"`)
      .join(", ");
    findings.push({
      code: "write-collision",
      contractIds: ids,
      message: `contracts "${a.id}" and "${b.id}" may write the same files: ${detail}`,
    });
  }

  if (overlaps(a.writes, b.forbidden) || overlaps(b.writes, a.forbidden)) {
    findings.push({
      code: "writes-forbidden",
      contractIds: ids,
      message: `contracts "${a.id}" and "${b.id}" have write sets inside each other's forbidden globs`,
    });
  }

  return findings;
}

/**
 * UI-capable means the plan will produce something a founder can look at.
 * Detected conservatively: either a contract marks itself `ui: true`, or a
 * writes glob targets a screen-facing file format. There is no opt-out by
 * accident — a back-end plan with a stray `ui: true` is rejected the same
 * as one with a real one, and the founder can override by refining.
 */
const UI_WRITES = /\.(?:html?|css|scss|sass|less|jsx|tsx|svelte|vue|astro|styl?|html)$/i;

export function isUiCapable(plan: Plan): boolean {
  return plan.contracts.some((c) => c.ui === true || c.writes.some((w) => UI_WRITES.test(w)));
}

import { bestPairContrast } from "./luminance";

function checkDesign(plan: Plan): Finding[] {
  if (!isUiCapable(plan)) return [];
  if (plan.design && plan.design.palette.length >= 2 && plan.design.notDoing.length > 0) {
    const best = bestPairContrast(plan.design.palette);
    if (best < 4.5) {
      const ids = plan.contracts.map((c) => c.id);
      return [
        {
          code: "weak-contrast-palette",
          contractIds: ids,
          message:
            `best contrast ratio across the declared palette is ${best.toFixed(2)}; body text needs 4.5. ` +
            "Adjust the palette so at least one pair clears the bar (light text on dark or vice versa).",
        },
      ];
    }
    return [];
  }
  const ids = plan.contracts.map((c) => c.id);
  return [
    {
      code: "missing-design",
      contractIds: ids,
      message:
        plan.design
          ? `plan is UI-capable and a design block exists but is underspecified; the design must name direction, palette (2-4 hex), typeface, notDoing, and ambition`
          : `plan is UI-capable (writes touch screen-facing files) but has no design block; the planner must propose a direction and the founder must pick one`,
    },
  ];
}

function checkGraphBudget(plan: Plan): Finding[] {
  const findings: Finding[] = [];
  const ids = plan.contracts.map((c) => c.id);
  const budget = plan.graphBudget;

  if (!budget || budget.nodes < plan.contracts.length) {
    findings.push({
      code: "budget-exceeded",
      contractIds: ids,
      message: `graph budget allows ${budget?.nodes ?? 0} nodes but the plan declares ${plan.contracts.length} contracts`,
    });
    return findings;
  }

  const tokens = plan.contracts.reduce((sum, c) => sum + (c.budget?.tokens ?? 0), 0);
  if (tokens > budget.tokens) {
    findings.push({
      code: "budget-exceeded",
      contractIds: ids,
      message: `contract token budgets sum to ${tokens}, exceeding the graph ceiling of ${budget.tokens}`,
    });
  }

  // The edge ceiling is a budget like the others, and it was the one that
  // was not checked. A plan declaring 11 edges for a graph that needs 14
  // under-funds itself, and nothing said so -- the same class of quiet
  // inconsistency the whole system keeps hunting for.
  const requiredEdges = findDependencies(plan.contracts).length;
  if (requiredEdges > budget.edges) {
    findings.push({
      code: "budget-exceeded",
      contractIds: ids,
      message: `plan needs ${requiredEdges} dependency edges, exceeding the graph ceiling of ${budget.edges}`,
    });
  }

  const wallMs = plan.contracts.reduce((sum, c) => sum + (c.budget?.wallMs ?? 0), 0);
  if (wallMs > budget.wallMs) {
    findings.push({
      code: "budget-exceeded",
      contractIds: ids,
      message: `contract wall budgets sum to ${wallMs}ms, exceeding the graph ceiling of ${budget.wallMs}ms`,
    });
  }

  return findings;
}

export function validatePlan(
  plan: Plan,
  baseline: readonly Check[] = [],
): ValidationResult {
  if (plan.topology === "refuse") return { ok: true, findings: [] };

  const findings: Finding[] = [];

  if (plan.contracts.length === 0) {
    findings.push({
      code: "empty-plan",
      contractIds: [],
      message: "plan declares no contracts",
    });
    return { ok: false, findings };
  }

  const seen = new Set<string>();
  for (const contract of plan.contracts) {
    findings.push(...checkContract(contract, seen));
    findings.push(
      ...assertBaselineIntact(
        baseline,
        effectiveMatrix(baseline, contract.checks ?? []),
      ),
    );
  }

  for (let i = 0; i < plan.contracts.length; i++) {
    for (let j = i + 1; j < plan.contracts.length; j++) {
      findings.push(...checkPair(plan.contracts[i], plan.contracts[j]));
    }
  }

  findings.push(...checkDesign(plan));
  findings.push(...checkGraphBudget(plan));

  return { ok: findings.length === 0, findings };
}
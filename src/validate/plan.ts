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

  findings.push(...checkGraphBudget(plan));

  return { ok: findings.length === 0, findings };
}
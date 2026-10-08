import type { Check, CheckKind, Finding } from "../contracts/types";

/** D9: `judgment` is not admitted in v1. Cut it here rather than trusting a prompt. */
const SUPPORTED_KINDS: readonly CheckKind[] = ["baseline", "coverage", "intent"];

function blank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

/**
 * The effective matrix is computed by union, never declared by the worker.
 * That makes dropping a baseline check structurally impossible rather than
 * merely discouraged — an engineer under budget pressure cannot subtract.
 *
 * On duplicate commands the baseline entry wins: contract checks may add
 * coverage, never override a standing project rule.
 */
export function effectiveMatrix(
  baseline: readonly Check[],
  contractChecks: readonly Check[],
): Check[] {
  const byCommand = new Map<string, Check>();
  for (const check of [...baseline, ...contractChecks]) {
    if (!byCommand.has(check.command)) byCommand.set(check.command, check);
  }
  return [...byCommand.values()];
}

export function validateChecks(
  contractChecks: readonly Check[],
  contractId: string,
): Finding[] {
  const findings: Finding[] = [];
  const at = [contractId];
  const seen = new Set<string>();

  for (const check of contractChecks) {
    if (seen.has(check.id)) {
      findings.push({
        code: "invalid-check",
        contractIds: at,
        message: `contract "${contractId}" repeats check id "${check.id}"`,
      });
    }
    seen.add(check.id);

    if (!SUPPORTED_KINDS.includes(check.kind)) {
      findings.push({
        code: "unsupported-check-kind",
        contractIds: at,
        message: `contract "${contractId}" declares a "${check.kind}" check, which v1 does not admit`,
      });
    }

    if (blank(check.command) || blank(check.expectation)) {
      findings.push({
        code: "invalid-check",
        contractIds: at,
        message: `contract "${contractId}" has check "${check.id}" without a command or expectation`,
      });
    }

    // A non-convergent blocking check is a budget trap: the worker cannot make
    // it pass in one revision, so the revise cap fires and it fails anyway.
    // Advisory is the correct home for anything that does not converge.
    if (check.gating === "blocking" && check.convergent === false) {
      findings.push({
        code: "invalid-check",
        contractIds: at,
        message: `contract "${contractId}" has blocking check "${check.id}" marked non-convergent; that combination can never pass a revise round`,
      });
    }
  }

  return findings;
}

/**
 * Guard for callers that build a matrix outside `effectiveMatrix` — the gate
 * and tester paths. Cheap enough to keep as belt-and-braces.
 */
export function assertBaselineIntact(
  baseline: readonly Check[],
  effective: readonly Check[],
): Finding[] {
  const present = new Set(effective.map((check) => check.command));
  const missing = baseline.filter((check) => !present.has(check.command));

  if (missing.length === 0) return [];

  return [
    {
      code: "baseline-dropped",
      contractIds: [],
      message: `baseline checks missing from the effective matrix: ${missing
        .map((check) => check.command)
        .join(", ")}`,
    },
  ];
}
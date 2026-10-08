import { describe, expect, test } from "bun:test";
import type { Check } from "../../src/contracts/types";
import {
  assertBaselineIntact,
  effectiveMatrix,
  validateChecks,
} from "../../src/validate/matrix";
import { validatePlan } from "../../src/validate/plan";

function check(overrides: Partial<Check> = {}): Check {
  return {
    id: "typecheck",
    kind: "baseline",
    command: "npm run typecheck",
    expectation: "exit code 0",
    gating: "blocking",
    convergent: true,
    ...overrides,
  };
}

const baseline: Check[] = [
  check({ id: "lint", command: "npm run lint", expectation: "exit code 0" }),
  check({ id: "typecheck", command: "npm run typecheck", expectation: "exit code 0" }),
];

describe("effectiveMatrix", () => {
  test("keeps every baseline check when a contract adds none", () => {
    expect(effectiveMatrix(baseline, []).map((c) => c.command)).toEqual([
      "npm run lint",
      "npm run typecheck",
    ]);
  });

  test("adds contract checks without dropping baseline ones", () => {
    const matrix = effectiveMatrix(baseline, [
      check({ id: "cov", kind: "coverage", command: "vitest --changed" }),
    ]);
    expect(matrix).toHaveLength(3);
    expect(matrix.map((c) => c.command)).toContain("npm run lint");
  });

  test("a contract cannot drop a baseline check", () => {
    const matrix = effectiveMatrix(baseline, [
      check({ id: "cov", kind: "coverage", command: "vitest --changed" }),
    ]);
    expect(assertBaselineIntact(baseline, matrix)).toHaveLength(0);
  });

  test("a contract cannot override a baseline check with the same command", () => {
    const matrix = effectiveMatrix(baseline, [
      check({ id: "typecheck", command: "npm run typecheck", expectation: "always passes" }),
    ]);
    const typecheck = matrix.find((c) => c.command === "npm run typecheck");
    expect(typecheck?.expectation).toBe("exit code 0");
  });
});

describe("validateChecks", () => {
  test("accepts baseline, coverage and intent checks", () => {
    const findings = validateChecks(
      [
        check({ id: "a", kind: "baseline" }),
        check({ id: "b", kind: "coverage", command: "vitest --changed" }),
        check({ id: "c", kind: "intent", command: "npm test -- edge" }),
      ],
      "w1",
    );
    expect(findings).toHaveLength(0);
  });

  test("rejects judgment checks in v1", () => {
    const findings = validateChecks([check({ id: "j", kind: "judgment" })], "w1");
    expect(findings.map((f) => f.code)).toContain("unsupported-check-kind");
  });

  test("rejects a check with no command or expectation", () => {
    const findings = validateChecks(
      [check({ id: "a", command: "", expectation: "  " })],
      "w1",
    );
    expect(findings.map((f) => f.code)).toContain("invalid-check");
  });

  test("rejects duplicate check ids within a contract", () => {
    const findings = validateChecks(
      [
        check({ id: "dup", command: "npm run lint" }),
        check({ id: "dup", command: "npm test" }),
      ],
      "w1",
    );
    expect(findings.map((f) => f.code)).toContain("invalid-check");
  });
});

describe("assertBaselineIntact", () => {
  test("flags a hand-built matrix that omits a baseline check", () => {
    const findings = assertBaselineIntact(baseline, [baseline[0]]);
    expect(findings.map((f) => f.code)).toEqual(["baseline-dropped"]);
  });

  test("passes when every baseline check is present", () => {
    expect(assertBaselineIntact(baseline, baseline)).toHaveLength(0);
  });
});

describe("validatePlan with checks", () => {
  const plan = (checks: Check[]) => ({
    topology: "fan-out" as const,
    contracts: [
      {
        id: "w1",
        objective: "do the thing",
        reads: ["src/a.ts"],
        writes: ["src/a.ts"],
        forbidden: [],
        deliverable: "diff" as const,
        schema: { type: "object" },
        doneWhen: "tests pass",
        checks,
        budget: { tokens: 1000, toolCalls: 10, wallMs: 60_000 },
      },
    ],
    graphBudget: { nodes: 8, edges: 16, tokens: 100_000, wallMs: 600_000 },
  });

  test("a plan with baseline checks plus one blocking contract check is valid", () => {
    expect(
      validatePlan(plan([check({ id: "unit", kind: "intent", command: "npm test -- src/a" })]), baseline).ok,
    ).toBe(true);
  });

  test("a diff contract with no checks at all fails the blocking gate", () => {
    expect(validatePlan(plan([]), baseline).findings.map((f) => f.code)).toContain(
      "no-blocking-check",
    );
  });

  test("a contract smuggling in a judgment check fails validation", () => {
    const result = validatePlan(plan([check({ id: "j", kind: "judgment" })]), baseline);
    expect(result.findings.map((f) => f.code)).toContain("unsupported-check-kind");
  });
});
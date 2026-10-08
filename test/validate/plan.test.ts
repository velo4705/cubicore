import { describe, expect, test } from "bun:test";
import type { Check, Contract, Plan } from "../../src/contracts/types";
import { validatePlan } from "../../src/validate/plan";

function blockingCheck(overrides: Partial<Check> = {}): Check {
  return {
    id: "unit",
    kind: "intent",
    command: "npm test -- src/a",
    expectation: "exit code 0",
    gating: "blocking",
    convergent: true,
    ...overrides,
  };
}

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "w1",
    objective: "do the thing",
    reads: ["src/a.ts"],
    writes: ["src/a.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: { type: "object" },
    doneWhen: "npm test -- src/a passes",
    checks: [blockingCheck()],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 60_000 },
    ...overrides,
  };
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    topology: "fan-out",
    contracts: [contract()],
    graphBudget: { nodes: 8, edges: 16, tokens: 100_000, wallMs: 600_000 },
    ...overrides,
  };
}

function codes(result: ReturnType<typeof validatePlan>): string[] {
  return result.findings.map((f) => f.code);
}

describe("validatePlan", () => {
  test("accepts a well-formed single contract", () => {
    expect(validatePlan(plan()).ok).toBe(true);
  });

  test("treats refusal as a valid outcome", () => {
    const result = validatePlan(plan({ topology: "refuse", contracts: [] }));
    expect(result.ok).toBe(true);
  });

  test("rejects an empty plan", () => {
    expect(codes(validatePlan(plan({ contracts: [] })))).toContain("empty-plan");
  });

  test("rejects duplicate contract ids", () => {
    const result = validatePlan(
      plan({ contracts: [contract({ id: "w1" }), contract({ id: "w1" })] }),
    );
    expect(codes(result)).toContain("duplicate-id");
  });

  test("rejects two workers writing the same file", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ id: "w1", writes: ["src/a.ts"] }),
          contract({ id: "w2", writes: ["src/a.ts"] }),
        ],
      }),
    );
    expect(codes(result)).toContain("write-collision");
  });

  test("rejects write overlap hidden behind globs", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ id: "w1", writes: ["src/**"] }),
          contract({ id: "w2", writes: ["src/deep/b.ts"] }),
        ],
      }),
    );
    expect(codes(result)).toContain("write-collision");
  });

  test("allows disjoint write sets", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ id: "w1", writes: ["src/frontend/**"] }),
          contract({ id: "w2", writes: ["src/backend/**"] }),
        ],
      }),
    );
    expect(codes(result)).not.toContain("write-collision");
  });

  test("allows overlapping reads", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ id: "w1", reads: ["src/**"], writes: ["src/a.ts"] }),
          contract({ id: "w2", reads: ["src/**"], writes: ["src/b.ts"] }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("rejects writing into another contract's forbidden set", () => {
    const result = validatePlan(
      plan({
        contracts: [
          contract({ id: "w1", writes: ["src/a.ts"] }),
          contract({ id: "w2", writes: ["src/b.ts"], forbidden: ["src/**"] }),
        ],
      }),
    );
    expect(codes(result)).toContain("writes-forbidden");
  });

  test("requires a blocking check for a diff deliverable", () => {
    const bare = contract({ checks: [] });
    expect(codes(validatePlan(plan({ contracts: [bare] })))).toContain(
      "no-blocking-check",
    );
  });

  test("an advisory-only check is not a gate", () => {
    const advisory = contract({
      checks: [blockingCheck({ gating: "advisory" })],
    });
    expect(codes(validatePlan(plan({ contracts: [advisory] })))).toContain(
      "no-blocking-check",
    );
  });

  test("does not require a blocking check for report deliverables", () => {
    const report = contract({ deliverable: "report", checks: [] });
    expect(validatePlan(plan({ contracts: [report] })).ok).toBe(true);
  });

  test("rejects a blocking check that cannot converge", () => {
    const stuck = contract({
      checks: [blockingCheck({ convergent: false })],
    });
    expect(codes(validatePlan(plan({ contracts: [stuck] })))).toContain(
      "invalid-check",
    );
  });

  test("rejects a contract with a non-positive budget", () => {
    const result = validatePlan(
      plan({
        contracts: [contract({ budget: { tokens: 0, toolCalls: 5, wallMs: 5 } })],
      }),
    );
    expect(codes(result)).toContain("invalid-budget");
  });

  test("rejects contract budgets that exceed the graph ceiling", () => {
    const result = validatePlan(
      plan({ graphBudget: { nodes: 8, edges: 16, tokens: 100, wallMs: 600_000 } }),
    );
    expect(codes(result)).toContain("budget-exceeded");
  });

  test("rejects a graph budget too small to hold the contracts", () => {
    const result = validatePlan(
      plan({ graphBudget: { nodes: 0, edges: 0, tokens: 1, wallMs: 1 } }),
    );
    expect(codes(result)).toContain("budget-exceeded");
  });
});
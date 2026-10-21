import { describe, expect, it, test } from "bun:test";
import { validatePlan } from "../src/validate/plan";

describe("graph budget", () => {
  test("rejects a plan whose edge ceiling is below what it needs", () => {
    // The one budget that was not checked. A plan declaring 11 edges for a
    // graph that needs 14 under-funds itself, and validation passed it.
    const plan = {
      topology: "pipeline",
      contracts: [
        {
          id: "types",
          objective: "write the shared types",
          reads: [],
          writes: ["src/types.ts"],
          forbidden: [],
          deliverable: "diff",
          schema: { type: "object" },
          doneWhen: "types exist",
          checks: [
            {
              id: "t",
              kind: "intent",
              command: "test -f src/types.ts",
              expectation: "types exist",
              gating: "blocking",
              convergent: true,
            },
          ],
          budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
        },
        {
          id: "route",
          objective: "write a route that imports the types",
          reads: ["src/types.ts"],
          writes: ["src/route.ts"],
          forbidden: [],
          deliverable: "diff",
          schema: { type: "object" },
          doneWhen: "route exists",
          checks: [
            {
              id: "r",
              kind: "intent",
              command: "test -f src/route.ts",
              expectation: "route exists",
              gating: "blocking",
              convergent: true,
            },
          ],
          budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
        },
      ],
      // One edge is needed; the ceiling says zero.
      graphBudget: { nodes: 2, edges: 0, tokens: 2000, wallMs: 5000 },
    };

    const findings = validatePlan(plan as never, []);
    expect(findings.ok).toBe(false);
    expect(findings.findings.some((f) => f.code === "budget-exceeded")).toBe(true);
  });

  test("accepts a plan whose edge ceiling covers it", () => {
    const plan = {
      topology: "pipeline",
      contracts: [
        {
          id: "types",
          objective: "write the shared types",
          reads: [],
          writes: ["src/types.ts"],
          forbidden: [],
          deliverable: "diff",
          schema: { type: "object" },
          doneWhen: "types exist",
          checks: [
            {
              id: "t",
              kind: "intent",
              command: "test -f src/types.ts",
              expectation: "types exist",
              gating: "blocking",
              convergent: true,
            },
          ],
          budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
        },
        {
          id: "route",
          objective: "write a route that imports the types",
          reads: ["src/types.ts"],
          writes: ["src/route.ts"],
          forbidden: [],
          deliverable: "diff",
          schema: { type: "object" },
          doneWhen: "route exists",
          checks: [
            {
              id: "r",
              kind: "intent",
              command: "test -f src/route.ts",
              expectation: "route exists",
              gating: "blocking",
              convergent: true,
            },
          ],
          budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
        },
      ],
      graphBudget: { nodes: 2, edges: 1, tokens: 2000, wallMs: 5000 },
    };

    expect(validatePlan(plan as never, []).ok).toBe(true);
  });
});

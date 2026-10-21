import { describe, expect, it } from "bun:test";

import { assessPlan } from "../src/plan/assess";
import { parsePlan } from "../src/coordinator/parse";

/**
 * The plan loop was unbounded. plan_write rejects a bad plan, the agent
 * re-plans, it is rejected again, and nothing stopped that except the founder
 * giving up. The execute -> test loop has a cap; the plan loop did not.
 */

const planOf = (contracts: unknown[]) =>
  parsePlan(
    JSON.stringify({
      topology: "fan-out",
      contracts,
      graphBudget: { nodes: 4, edges: 1, tokens: 4000, wallMs: 4000 },
    }),
  );

const good = (id: string, writes: string[]) => ({
  id,
  objective: "Do the thing with enough specificity to be actionable",
  reads: [],
  writes,
  forbidden: [],
  deliverable: "diff",
  schema: { type: "object" },
  doneWhen: "it is done",
  checks: [
    {
      id: "k",
      kind: "intent",
      command: "bunx --bun tsx -e \"assert(true)\"",
      expectation: "e",
      gating: "blocking",
      convergent: true,
    },
  ],
  budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
});

describe("plan specificity", () => {
  it("accepts a plan with concrete, disjoint scopes", () => {
    const a = assessPlan(planOf([good("a", ["src/a.ts"]), good("b", ["src/b.ts"])]));
    expect(a.plannable).toBe(true);
  });

  it("rejects a plan whose scopes claim the whole tree", () => {
    const a = assessPlan(planOf([good("a", ["src/**"])]));
    expect(a.plannable).toBe(false);
    expect(a.blockers.map((b) => b.code)).toContain("catch-all-write-scope");
  });

  it("rejects a plan whose scopes overlap", () => {
    const a = assessPlan(planOf([good("a", ["src/x.ts"]), good("b", ["src/x.ts"])]));
    expect(a.plannable).toBe(false);
  });

  it("offers a default rather than only demanding an answer", () => {
    const a = assessPlan(planOf([good("a", ["src/**"])]));
    const asked = a.questions.join(" ");
    expect(asked).toContain("conventional layout");
  });
});

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

describe("checks are judged by whether they can fail, not by whether they are code", () => {
  const c = (over: Record<string, unknown> = {}) => ({
    id: "a",
    objective: "Do the thing with enough specificity to be actionable",
    reads: [],
    writes: ["notes/section.md"],
    forbidden: [],
    deliverable: "report",
    schema: { type: "object" },
    doneWhen: "it is done",
    checks: [
      {
        id: "k",
        kind: "intent",
        command: "grep -q '## References' notes/section.md",
        expectation: "the section has references",
        gating: "blocking",
        convergent: true,
      },
    ],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    ...over,
  });

  it("does not object to a grep in a non-code deliverable", () => {
    // Grepping a document for a required section is a legitimate check.
    const a = assessPlan(planOf([c()]));
    expect(a.blockers.map((b) => b.code)).not.toContain("grep-only-check");
  });

  it("objects to a grep that is the only gate on a diff", () => {
    const a = assessPlan(
      planOf([
        c({
          deliverable: "diff",
          writes: ["src/a.ts"],
          checks: [
            {
              id: "k",
              kind: "intent",
              command: "grep -q valid src/a.ts",
              expectation: "e",
              gating: "blocking",
              convergent: true,
            },
          ],
        }),
      ]),
    );
    expect(a.blockers.map((b) => b.code)).toContain("grep-only-check");
  });

  it("allows a grep alongside a check that can actually fail", () => {
    const a = assessPlan(
      planOf([
        c({
          deliverable: "diff",
          writes: ["src/a.ts"],
          checks: [
            {
              id: "g",
              kind: "intent",
              command: "grep -q valid src/a.ts",
              expectation: "e",
              gating: "blocking",
              convergent: true,
            },
            {
              id: "t",
              kind: "intent",
              command: "bun test src/a.test.ts",
              expectation: "e",
              gating: "blocking",
              convergent: true,
            },
          ],
        }),
      ]),
    );
    expect(a.blockers.map((b) => b.code)).not.toContain("grep-only-check");
  });
});

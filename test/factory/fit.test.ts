import { describe, expect, test, it } from "bun:test";
import type { Contract, Plan } from "../../src/contracts/types";
import { assessFactoryFit } from "../../src/factory/fit";

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "w1",
    objective: "do the thing",
    reads: ["src/a.ts"],
    writes: ["src/a.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: { type: "object" },
    doneWhen: "done",
    checks: [],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 60_000 },
    ...overrides,
  };
}

function plan(contracts: Contract[], topology: Plan["topology"] = "fan-out"): Plan {
  return {
    topology,
    contracts,
    graphBudget: { nodes: 8, edges: 0, tokens: 100_000, wallMs: 600_000 },
  };
}

describe("assessFactoryFit", () => {
  test("a single contract is a single agent", () => {
    const fit = assessFactoryFit(plan([contract()]));
    expect(fit.decision).toBe("single-agent");
    expect(fit.workers).toBe(1);
    expect(fit.confidence).toBe("high");
  });

  test("two disjoint small contracts make a small factory", () => {
    const fit = assessFactoryFit(
      plan([
        contract({ id: "w1", writes: ["src/a.ts"], reads: ["src/a.ts"] }),
        contract({ id: "w2", writes: ["src/b.ts"], reads: ["src/b.ts"] }),
      ]),
    );
    expect(fit.decision).toBe("small-factory");
    expect(fit.workers).toBe(2);
    expect(fit.confidence).toBe("high");
  });

  test("tight pairwise dependency makes a pipeline", () => {
    const contracts = [
      contract({ id: "a", writes: ["src/types.ts"], reads: ["src/types.ts"] }),
      contract({ id: "b", writes: ["src/b.ts"], reads: ["src/types.ts"] }),
      contract({ id: "c", writes: ["src/c.ts"], reads: ["src/types.ts"] }),
    ];
    const fit = assessFactoryFit(plan(contracts));
    expect(fit.decision).toBe("pipeline");
  });

  test("refuse topology stays a single agent", () => {
    const fit = assessFactoryFit(plan([contract()], "refuse"));
    expect(fit.decision).toBe("single-agent");
    expect(fit.confidence).toBe("high");
  });

  test("many read-heavy contracts make a single-reader", () => {
    const contracts = [
      contract({ id: "a", reads: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], writes: ["docs/a.md"] }),
      contract({ id: "b", reads: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], writes: ["docs/b.md"] }),
      contract({ id: "c", reads: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], writes: ["docs/c.md"] }),
      contract({ id: "d", reads: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], writes: ["docs/d.md"] }),
    ];
    const fit = assessFactoryFit(plan(contracts));
    expect(fit.decision).toBe("single-reader");
  });

  test("standard-factory for a mid-sized disjoint batch", () => {
    const contracts = Array.from({ length: 5 }, (_, i) =>
      contract({ id: `w${i}`, writes: [`src/f${i}.ts`], reads: [`src/f${i}.ts`] }),
    );
    const fit = assessFactoryFit(plan(contracts));
    expect(fit.decision).toBe("standard-factory");
    expect(fit.workers).toBe(5);
  });
});

describe("synthesizeSingleAgentPlan", () => {
  it("merges disjoint contracts into one, preserving checks", async () => {
    const { synthesizeSingleAgentPlan } = await import("../../src/factory/fit");
    const src = plan([
      contract({ id: "a", writes: ["src/a.ts"], objective: "do a", ui: true }),
      contract({ id: "b", writes: ["src/b.ts"], objective: "do b", checks: [
        { id: "unit", kind: "intent", command: "npm run a", expectation: "pass", gating: "blocking", convergent: true },
      ] }),
    ], "fan-out");
    const once = synthesizeSingleAgentPlan(src as never);
    expect(once.contracts).toHaveLength(1);
    expect(once.contracts[0]?.writes).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
    expect(once.contracts[0]?.checks.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(["unit"]));
    expect(once.graphBudget.nodes).toBe(1);
    expect(once.contracts[0]?.ui).toBe(true);
    expect(once.design).toBe(src.design);
  });

  it("is a no-op for a single contract", async () => {
    const { synthesizeSingleAgentPlan } = await import("../../src/factory/fit");
    const src = plan([contract({ id: "solo" })], "fan-out");
    expect(synthesizeSingleAgentPlan(src as never).contracts).toHaveLength(1);
  });
});

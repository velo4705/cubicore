import { describe, expect, test } from "bun:test";
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

function plan(contracts: Contract[], topology: Plan["topology"] = "fan-out"): Pick<Plan, "topology" | "contracts"> {
  return { topology, contracts };
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

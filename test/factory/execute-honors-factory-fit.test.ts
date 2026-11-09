import { describe, expect, test } from "bun:test";
import { synthesizeSingleAgentPlan, assessFactoryFit } from "/home/nix/Projects/cubicore/src/factory/fit";
import { dispatch } from "/home/nix/Projects/cubicore/src/dispatch";
import type { Plan } from "/home/nix/Projects/cubicore/src/contracts/types";

const fiveDisjoint = (n: number): Plan => ({
  topology: "fan-out",
  contracts: Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    objective: `build module ${i}`,
    reads: [`src/${i}.ts`],
    writes: [`src/${i}.ts`],
    forbidden: [],
    deliverable: "diff",
    schema: { type: "object" },
    doneWhen: "done",
    checks: [
      { id: "t", kind: "intent", command: "true", expectation: "exit 0", gating: "blocking", convergent: true },
    ],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 60_000 },
  })),
  graphBudget: { nodes: n + 2, edges: 0, tokens: 100_000, wallMs: 600_000 },
  factoryFit: {
    decision: n === 1 ? "single-agent" : "standard-factory",
    workers: n,
    confidence: "high",
    topology: "fan-out",
    why: `assessed: ${n} independent units`,
    whyNotMore: "no further split pays",
    evidence: [`${n} disjoint contracts`],
  },
}) as never;

describe("dispatch honors the factory-fit decision", () => {
  test("standard-factory runs every contract", async () => {
    const plan = fiveDisjoint(5);
    const seen: string[] = [];
    await dispatch(plan, {
      async run(contract: { id: string }) {
        seen.push(contract.id);
        return { artifact: { contractId: contract.id, deliverable: "diff", raw: "x" }, changedFiles: [], usage: {} as never, ms: 0, toolCalls: 0, changesUnknown: false } as never;
      },
    }, { async run() { return { exitCode: 0, output: "" }; } });
    expect(new Set(seen)).toEqual(new Set(["w0", "w1", "w2", "w3", "w4"]));
  });

  test("single-agent decision collapses the plan to one dispatch, all writes retained", async () => {
    const plan = fiveDisjoint(2);
    const synth = synthesizeSingleAgentPlan(plan as never);
    expect(synth.contracts).toHaveLength(1);
    expect(synth.contracts[0]?.id).toBe("solo");
    expect(synth.graphBudget.nodes).toBe(1);
    expect(new Set(synth.contracts[0]?.writes)).toEqual(new Set(["src/0.ts", "src/1.ts"]));
  });
});

describe("assessFactoryFit — the reason is recorded", () => {
  test("a genuinely independent batch gets a justified team", () => {
    const fit = assessFactoryFit({
      topology: "fan-out",
      contracts: Array.from({ length: 6 }, (_, i) => ({
        id: `w${i}`,
        objective: `build module ${i}`,
        reads: [`src/${i}.ts`],
        writes: [`src/${i}.ts`],
        forbidden: [],
        deliverable: "diff",
        schema: { type: "object" },
        doneWhen: "done",
        checks: [],
        budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
      })),
    });
    expect(fit.decision).toBe("standard-factory");
    expect(fit.evidence.join(" ")).toContain("6 contracts");
  });
});

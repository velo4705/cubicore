import { describe, expect, it } from "bun:test";

import { parsePlan } from "../src/coordinator/parse";
import { validatePlan } from "../src/validate/plan";
import { checkTopology } from "../src/coordinator/topology";
import type { Plan } from "../src/contracts/types";

/**
 * The coordinator was removed: `cubicore` now takes a plan directly, because
 * the agent calling the tool already has the repo context a planner lacked.
 * These tests cover the gate that stands in front of dispatch.
 */

function contract(id: string, writes: string[], reads: string[] = []) {
  return {
    id,
    objective: `Handle ${id}`,
    reads,
    writes,
    forbidden: [],
    deliverable: "diff",
    schema: { type: "object", properties: { files: { type: "array" } } },
    doneWhen: "checks pass",
    checks: [
      {
        id: `${id}-lint`,
        kind: "baseline",
        command: "bun run lint",
        expectation: "exit 0",
        gating: "blocking",
        convergent: true,
      },
    ],
    budget: { tokens: 20_000, toolCalls: 40, wallMs: 120_000 },
  };
}

const GOOD = JSON.stringify({
  topology: "fan-out",
  contracts: [contract("a", ["src/a.ts"]), contract("b", ["src/b.ts"])],
  graphBudget: { nodes: 2, edges: 1, tokens: 40_000, wallMs: 300_000 },
});

function gate(raw: string) {
  const parsed = parsePlan(raw) as Plan;
  return { parsed, validation: validatePlan(parsed, []), topology: checkTopology(parsed) };
}

describe("direct plan input", () => {
  it("accepts a well-formed plan the calling agent produced", () => {
    const { validation, topology } = gate(GOOD);
    expect(validation.ok).toBe(true);
    expect(topology.ok).toBe(true);
    expect(topology.cycles).toHaveLength(0);
  });

  it("reports malformed JSON rather than dispatching on a guess", () => {
    expect(() => parsePlan("{ not json")).toThrow();
  });

  it("rejects overlapping writes before any token is spent", () => {
    const overlapping = JSON.parse(GOOD);
    overlapping.contracts[1].writes = ["src/a.ts"];
    const { validation } = gate(JSON.stringify(overlapping));
    expect(validation.ok).toBe(false);
    expect(validation.findings.some((f) => f.code === "write-collision")).toBe(true);
  });

  it("flags a cycle as non-decomposable rather than a mis-declaration", () => {
    const cyclic = JSON.parse(GOOD);
    cyclic.contracts[0].reads = ["src/b.ts"];
    cyclic.contracts[1].reads = ["src/a.ts"];
    const { topology } = gate(JSON.stringify(cyclic));
    expect(topology.cycles.length).toBeGreaterThan(0);
    // A cycle is terminal: no ordering satisfies it, so the caller must refuse.
    expect(topology.ok).toBe(false);
  });

  it("treats `refuse` as a valid caller decision, not a parse failure", () => {
    const refused = JSON.parse(GOOD);
    refused.topology = "refuse";
    refused.contracts = [];
    expect(gate(JSON.stringify(refused)).parsed.topology).toBe("refuse");
  });

  it("allows overlapping reads, which is the single-reader case", () => {
    const shared = JSON.parse(GOOD);
    shared.contracts[0].reads = ["src/shared.ts"];
    shared.contracts[1].reads = ["src/shared.ts"];
    expect(gate(JSON.stringify(shared)).validation.ok).toBe(true);
  });
});
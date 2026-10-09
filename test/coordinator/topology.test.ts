import { describe, expect, test } from "bun:test";
import {
  checkTopology,
  findDependencies,
  impliedTopology,
  stages,
} from "../../src/coordinator/topology";
import type { Contract, Plan } from "../../src/contracts/types";

function contract(id: string, writes: string[], reads: string[] = []): Contract {
  return {
    id,
    objective: id,
    reads,
    writes,
    forbidden: [],
    deliverable: "diff",
    schema: {},
    doneWhen: "d",
    checks: [],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
  };
}

function plan(topology: Plan["topology"], contracts: Contract[]): Plan {
  return {
    topology,
    contracts,
    graphBudget: { nodes: 16, edges: 32, tokens: 100000, wallMs: 600000 },
  };
}

describe("findDependencies", () => {
  test("no overlap means no edges, so a fan-out is genuinely parallel", () => {
    const edges = findDependencies([
      contract("a", ["src/a.ts"]),
      contract("b", ["src/b.ts"]),
    ]);
    expect(edges).toEqual([]);
  });

  test("a contract reading another's writes is dependent on it", () => {
    const edges = findDependencies([
      contract("types", ["src/types.ts"]),
      contract("parser", ["src/parser.ts"], ["src/types.ts"]),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ producer: "types", consumer: "parser" });
  });

  test("detects a dependency hidden behind a glob", () => {
    const edges = findDependencies([
      contract("types", ["src/types.ts"]),
      contract("parser", ["src/parser.ts"], ["src/**"]),
    ]);
    expect(edges.length).toBeGreaterThan(0);
  });

  test("a contract does not depend on itself", () => {
    const edges = findDependencies([contract("a", ["src/a.ts"], ["src/a.ts"])]);
    expect(edges).toEqual([]);
  });

  test("each relation is reported once despite many matching paths", () => {
    const edges = findDependencies([
      contract("types", ["src/types.ts", "src/types.d.ts"]),
      contract("parser", ["src/parser.ts"], ["src/types.ts", "src/types.d.ts"]),
    ]);
    expect(edges.filter((e) => e.producer === "types" && e.consumer === "parser")).toHaveLength(2);
  });
});

describe("stages", () => {
  test("independent contracts collapse into one stage", () => {
    const pipeline = stages([
      contract("a", ["src/a.ts"]),
      contract("b", ["src/b.ts"]),
    ]);
    expect(pipeline.stages).toHaveLength(1);
    expect(pipeline.stages[0].contracts).toHaveLength(2);
  });

  test("a dependency splits into ordered stages", () => {
    const pipeline = stages([
      contract("types", ["src/types.ts"]),
      contract("parser", ["src/parser.ts"], ["src/types.ts"]),
    ]);
    expect(pipeline.stages).toHaveLength(2);
    expect(pipeline.stages[0].contracts.map((c) => c.id)).toEqual(["types"]);
    expect(pipeline.stages[1].contracts.map((c) => c.id)).toEqual(["parser"]);
  });

  test("a three-stage chain orders correctly", () => {
    const pipeline = stages([
      contract("c", ["src/c.ts"], ["src/b.ts"]),
      contract("b", ["src/b.ts"], ["src/a.ts"]),
      contract("a", ["src/a.ts"]),
    ]);
    expect(pipeline.stages.map((s) => s.contracts.map((c) => c.id))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  test("unrelated contracts share a stage even alongside a dependent pair", () => {
    const pipeline = stages([
      contract("types", ["src/types.ts"]),
      contract("parser", ["src/parser.ts"], ["src/types.ts"]),
      contract("unrelated", ["docs/readme.md"]),
    ]);
    expect(pipeline.stages).toHaveLength(2);
    expect(pipeline.stages[0].contracts.map((c) => c.id).sort()).toEqual(["types", "unrelated"]);
  });

  test("a dependency cycle is reported rather than deadlocking", () => {
    const pipeline = stages([
      contract("a", ["src/a.ts"], ["src/b.ts"]),
      contract("b", ["src/b.ts"], ["src/a.ts"]),
    ]);
    expect(pipeline.cycles.length).toBeGreaterThan(0);
    expect(pipeline.cycles[0]).toContain("a");
    expect(pipeline.cycles[0]).toContain("b");
  });

  test("a cyclic contract still appears in some stage rather than vanishing", () => {
    const pipeline = stages([
      contract("a", ["src/a.ts"], ["src/b.ts"]),
      contract("b", ["src/b.ts"], ["src/a.ts"]),
    ]);
    const scheduled = pipeline.stages.flatMap((s) => s.contracts.map((c) => c.id));
    expect(scheduled.sort()).toEqual(["a", "b"]);
  });

  test("an empty plan produces no stages", () => {
    expect(stages([]).stages).toEqual([]);
  });
});

describe("impliedTopology", () => {
  test("one stage implies fan-out", () => {
    expect(impliedTopology({ stages: stages([contract("a", ["src/a.ts"])]).stages, cycles: [] })).toBe("fan-out");
  });

  test("several stages imply pipeline", () => {
    const pipeline = stages([
      contract("types", ["src/types.ts"]),
      contract("parser", ["src/parser.ts"], ["src/types.ts"]),
    ]);
    expect(impliedTopology(pipeline)).toBe("pipeline");
  });

  test("a cycle implies refuse", () => {
    const pipeline = stages([
      contract("a", ["src/a.ts"], ["src/b.ts"]),
      contract("b", ["src/b.ts"], ["src/a.ts"]),
    ]);
    expect(impliedTopology(pipeline)).toBe("refuse");
  });
});

describe("checkTopology", () => {
  test("a correct fan-out passes", () => {
    const result = checkTopology(
      plan("fan-out", [contract("a", ["src/a.ts"]), contract("b", ["src/b.ts"])]),
    );
    expect(result.ok).toBe(true);
    expect(result.declared).toBe("fan-out");
    expect(result.implied).toBe("fan-out");
  });

  test("fan-out declared over dependent contracts is rejected", () => {
    const result = checkTopology(
      plan("fan-out", [
        contract("types", ["src/types.ts"]),
        contract("parser", ["src/parser.ts"], ["src/types.ts"]),
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.implied).toBe("pipeline");
    expect(result.messages[0]).toContain("fan-out");
    expect(result.messages[0]).toContain("types -> parser");
  });

  test("a cycle tells the planner to refuse", () => {
    const result = checkTopology(
      plan("fan-out", [
        contract("a", ["src/a.ts"], ["src/b.ts"]),
        contract("b", ["src/b.ts"], ["src/a.ts"]),
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.implied).toBe("refuse");
    expect(result.messages[0]).toContain('return topology "refuse"');
  });

  test("pipeline declared with no real dependency is flagged as slow", () => {
    const result = checkTopology(
      plan("pipeline", [contract("a", ["src/a.ts"]), contract("b", ["src/b.ts"])]),
    );
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toContain("fan-out would be faster");
  });

  test("a correct pipeline passes", () => {
    const result = checkTopology(
      plan("pipeline", [
        contract("types", ["src/types.ts"]),
        contract("parser", ["src/parser.ts"], ["src/types.ts"]),
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.implied).toBe("pipeline");
  });

  test("shared-context over dependent contracts is flagged", () => {
    const result = checkTopology(
      plan("shared-context", [
        contract("types", ["src/types.ts"]),
        contract("parser", ["src/parser.ts"], ["src/types.ts"]),
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.messages[0]).toContain("shared-context");
  });

  test("an explicit refusal is always accepted, cycles or not", () => {
    const result = checkTopology(
      plan("refuse", [
        contract("a", ["src/a.ts"], ["src/b.ts"]),
        contract("b", ["src/b.ts"], ["src/a.ts"]),
      ]),
    );
    expect(result.ok).toBe(true);
  });
});
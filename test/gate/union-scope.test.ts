import { describe, expect, test } from "bun:test";
import { gateUnionScope } from "../../src/gate/index";
import type { Contract } from "../../src/contracts/types";

const contract = (id: string, writes: string[], deliverable: "diff" | "report" = "diff"): Contract =>
  ({
    id,
    objective: "check the union gate",
    reads: [],
    writes,
    forbidden: [],
    deliverable,
    schema: { type: "object" },
    doneWhen: "done",
    checks: [],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 60_000 },
  }) as never;

const input = (id: string, writes: string[], deliverable: "diff" | "report" = "diff") => ({
  artifact: { contractId: id, deliverable, raw: "x" },
  contract: contract(id, writes, deliverable),
});

describe("gateUnionScope — the run is judged against the plan's union of declared writes", () => {
  test("a clean team whose changes stay inside declared scopes passes", () => {
    const result = gateUnionScope(input("marker-a", ["smoke-factory/a.txt"]), {
      changedFiles: ["smoke-factory/a.txt", "smoke-factory/b.txt"],
      unionWrites: ["smoke-factory/a.txt", "smoke-factory/b.txt"],
    });
    expect(result.passed).toBe(true);
  });

  test("files outside every declared write flag the run", () => {
    const result = gateUnionScope(input("marker-a", ["smoke-factory/a.txt"]), {
      changedFiles: ["smoke-factory/a.txt", "smoke-factory/evil.txt"],
      unionWrites: ["smoke-factory/a.txt", "smoke-factory/b.txt"],
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("smoke-factory/evil.txt");
  });

  test("a file inside another contract's scope still passes — union, not intersection", () => {
    const result = gateUnionScope(input("marker-a", ["smoke-factory/a.txt"]), {
      changedFiles: ["smoke-factory/b.txt"],
      unionWrites: ["smoke-factory/a.txt", "smoke-factory/b.txt"],
    });
    expect(result.passed).toBe(true);
  });

  test("unknown attribution fails honestly, never a pass and never a violation", () => {
    const result = gateUnionScope(input("marker-a", ["smoke-factory/a.txt"]), {
      changedFiles: [],
      changesUnknown: true,
      unionWrites: ["smoke-factory/a.txt"],
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("could not determine");
  });

  test("nothing changed and deliverable is a diff — work was not done", () => {
    const result = gateUnionScope(input("marker-a", ["smoke-factory/a.txt"]), {
      changedFiles: [],
      unionWrites: ["smoke-factory/a.txt"],
    });
    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(true);
  });

  test("unionWrites falls back to the contract's own writes when absent", () => {
    const result = gateUnionScope(input("marker-a", ["smoke-factory/a.txt"]), {
      changedFiles: ["other/declared-by-team.txt"],
    });
    expect(result.passed).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contractFingerprint } from "../../src/plan/contract-id";
import { satisfiedContracts } from "../../src/mcp/server";
import type { Contract, Plan } from "../../src/contracts/types";
import type { Run as RunState } from "../../src/mcp/runs";

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "core",
    objective: "build the core",
    reads: [],
    writes: ["src/a.ts", "src/b.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: {},
    doneWhen: "checks pass",
    checks: [{ id: "check", kind: "intent", command: "npm test", expectation: "exit 0", gating: "blocking", convergent: true }],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    ...overrides,
  };
}

function plan(contracts: Contract[]): Plan {
  return { topology: "fan-out", contracts, graphBudget: { nodes: 5, edges: 10, tokens: 10000, wallMs: 600000 } };
}

describe("stable contract identity", () => {
  test("survives an id change, a reworded brief and reordered writes", () => {
    const a = contract();
    const b = contract({ id: "renamed", objective: "a completely different sentence", writes: ["src/b.ts", "src/a.ts"] });
    expect(contractFingerprint(a)).toBe(contractFingerprint(b));
  });

  test("changes when a blocking check changes", () => {
    const changed = contract({ checks: [{ ...contract().checks[0], command: "npm run build" }] });
    expect(contractFingerprint(contract())).not.toBe(contractFingerprint(changed));
  });

  test("green work is reused after a plan rewrite renames the contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-stable-id-"));
    mkdirSync(join(dir, ".cubicore"), { recursive: true });
    const before = plan([contract({ id: "core-a" })]);
    const run = {
      id: "run-1",
      startedAt: 1,
      finishedAt: 2,
      plan: before,
      state: "done",
      progress: [{ contractId: "core-a", state: "done" }],
      directory: dir,
      baseline: "abc",
    } as unknown as RunState;
    writeFileSync(join(dir, ".cubicore", "runs.json"), JSON.stringify([run]));

    const after = plan([contract({ id: "core-renamed", objective: "rewritten brief" })]);
    expect(satisfiedContracts(dir, after)).toEqual(["core-renamed"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

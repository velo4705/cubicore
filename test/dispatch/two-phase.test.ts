import { describe, expect, test } from "bun:test";

import { dispatch, isVerifierContract, type PreparedWorker, type StagedWorkerRunner } from "../../src/dispatch";
import type { Contract, Plan, WorkerResult } from "../../src/contracts/types";

function contract(overrides: Partial<Contract>): Contract {
  return {
    id: "w",
    objective: "build it",
    reads: [],
    writes: ["src/w.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: {},
    doneWhen: "it exists",
    checks: [{ id: "u", kind: "intent", command: "test", expectation: "e", gating: "blocking", convergent: true }],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 5000 },
    ...overrides,
  };
}

function plan(contracts: Contract[]): Plan {
  return {
    topology: "pipeline",
    contracts,
    graphBudget: { nodes: 20, edges: 40, tokens: 100000, wallMs: 600000 },
  };
}

function result(id: string, changedFile = "src/w.ts"): WorkerResult {
  return {
    contractId: id,
    status: "accepted",
    artifact: { contractId: id, deliverable: "diff", raw: "done" },
    changedFiles: [changedFile],
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ms: 0,
    toolCalls: 0,
    cancelled: false,
  };
}

const gate = { async run() { return { exitCode: 0, output: "" }; } };

/**
 * Builders and verifiers in one plan. `core` writes a file that `consumer`
 * reads; `integration` is the fan-in verifier, `ui-smoke` verifies it.
 */
function twoPhasePlan() {
  return plan([
    contract({ id: "scaffold", writes: ["src/core.ts"] }),
    contract({ id: "consumer", reads: ["src/core.ts"], writes: ["src/a.ts"] }),
    contract({ id: "integration", reads: ["src/a.ts"], writes: ["src/main.ts"] }),
    contract({ id: "ui-smoke", reads: ["src/main.ts"], writes: ["tests/smoke.spec.ts"] }),
  ]);
}

function stagingRunner(events: string[]): StagedWorkerRunner {
  return {
    async prepare(c) {
      events.push(`prepare:${c.id}`);
      return { contractId: c.id };
    },
    async start(_handle: PreparedWorker, c) {
      events.push(`start:${c.id}`);
      return result(c.id, c.writes[0] ?? "src/w.ts");
    },
    async run(c) {
      events.push(`run:${c.id}`);
      return result(c.id, c.writes[0] ?? "src/w.ts");
    },
    abandon(handle) {
      events.push(`abandon:${handle.contractId}`);
    },
  };
}

describe("two-phase dispatch — all builders visible, verifiers last", () => {
  test("classifies verifiers by contract id", () => {
    expect(isVerifierContract(contract({ id: "integration" }))).toBe(true);
    expect(isVerifierContract(contract({ id: "ui-smoke" }))).toBe(true);
    expect(isVerifierContract(contract({ id: "acceptance-tests" }))).toBe(true);
    expect(isVerifierContract(contract({ id: "e2e-check" }))).toBe(true);
    expect(isVerifierContract(contract({ id: "game-loop-integration" }))).toBe(true);
    expect(isVerifierContract(contract({ id: "core-types" }))).toBe(false);
    expect(isVerifierContract(contract({ id: "app-integration" }))).toBe(true);
  });

  test("prepares every builder session before starting any of them", async () => {
    const events: string[] = [];
    await dispatch(twoPhasePlan(), stagingRunner(events), gate);
    const firstStart = Math.min(...events.map((e, i) => (e.startsWith("start:") ? i : Infinity)));
    expect(events.indexOf("prepare:consumer")).toBeLessThan(firstStart);
    expect(events.indexOf("prepare:scaffold")).toBeLessThan(firstStart);
    // Verifier sessions are NOT created up front.
    expect(events.indexOf("prepare:integration")).toBeGreaterThan(events.indexOf("start:consumer"));
    expect(events.indexOf("prepare:ui-smoke")).toBeGreaterThan(events.indexOf("start:consumer"));
  });

  test("still releases dependent builders in dependency order", async () => {
    const events: string[] = [];
    await dispatch(twoPhasePlan(), stagingRunner(events), gate);
    expect(events.indexOf("start:scaffold")).toBeLessThan(events.indexOf("start:consumer"));
    expect(events.indexOf("start:consumer")).toBeLessThan(events.indexOf("start:integration"));
    expect(events.indexOf("start:integration")).toBeLessThan(events.indexOf("start:ui-smoke"));
  });

  test("abandons prepared sessions that were never briefed after a halt", async () => {
    const events: string[] = [];
    let calls = 0;
    const runner = stagingRunner(events);
    await dispatch(plan([contract({ id: "a" }), contract({ id: "b" })]), runner, gate, {
      halt: () => (++calls === 1 ? "cancelled" : null),
    });
    expect(events).toContain("abandon:b");
    expect(events).not.toContain("start:b");
  });

  test("a legacy runner without prepare/start still runs every contract", async () => {
    const started: string[] = [];
    const legacy = {
      async run(c: Contract) {
        started.push(c.id);
        return result(c.id, c.writes[0] ?? "src/w.ts");
      },
    };
    const out = await dispatch(twoPhasePlan(), legacy, gate);
    expect(started.sort()).toEqual(["consumer", "integration", "scaffold", "ui-smoke"]);
    expect(out.accepted).toHaveLength(4);
  });
});

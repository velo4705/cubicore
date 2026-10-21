import { describe, expect, test } from "bun:test";
import { dispatch, planPermissions, shouldRetry, type WorkerRunner } from "../../src/dispatch";
import { aggregate } from "../../src/aggregate";
import type { Contract, Plan, WorkerResult } from "../../src/contracts/types";

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "w1",
    objective: "o",
    reads: ["src/**"],
    writes: ["src/a.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: {},
    doneWhen: "d",
    checks: [{ id: "u", kind: "intent", command: "test", expectation: "e", gating: "blocking", convergent: true }],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    ...overrides,
  };
}

function plan(contracts: Contract[]): Plan {
  return {
    topology: "fan-out",
    contracts,
    graphBudget: { nodes: 8, edges: 16, tokens: 100000, wallMs: 600000 },
  };
}

function ok(contractId: string, changedFiles: string[] = []): WorkerResult {
  return {
    contractId,
    status: "accepted",
    artifact: { contractId, deliverable: "diff", raw: "+ done" },
    changedFiles,
    usage: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    ms: 1000,
    toolCalls: 3,
    cancelled: false,
  };
}

const passGate = { async run() { return { exitCode: 0, output: "" }; } };
const failGate = { async run() { return { exitCode: 1, output: "FAIL" }; } };

describe("dispatch", () => {
  test("accepts workers that pass every gate", async () => {
    const runner: WorkerRunner = { async run(c) { return ok(c.id); } };
    const out = await dispatch(plan([contract()]), runner, passGate);
    expect(out.accepted).toHaveLength(1);
    expect(out.failed).toHaveLength(0);
  });

  test("retries once on a retryable failure, then gives up", async () => {
    let calls = 0;
    const runner: WorkerRunner = {
      async run(c) { calls++; return ok(c.id); },
    };
    const out = await dispatch(plan([contract()]), runner, failGate);
    expect(calls).toBe(2);
    expect(out.accepted).toHaveLength(0);
    expect(out.failed).toHaveLength(1);
  });

  test("does not retry a scope violation", async () => {
    let calls = 0;
    const runner: WorkerRunner = {
      async run(c) { calls++; return ok(c.id, ["src/elsewhere.ts"]); },
    };
    await dispatch(plan([contract()]), runner, passGate);
    expect(calls).toBe(1);
  });

  test("honours a zero-retry policy", async () => {
    let calls = 0;
    const runner: WorkerRunner = { async run(c) { calls++; return ok(c.id); } };
    await dispatch(plan([contract()]), runner, failGate, { maxRetries: 0 });
    expect(calls).toBe(1);
  });

  test("runs contracts concurrently", async () => {
    const inflight: number[] = [];
    let live = 0;
    const runner: WorkerRunner = {
      async run(c) {
        live++;
        inflight.push(live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return ok(c.id);
      },
    };
    await dispatch(
      plan([contract({ id: "a" }), contract({ id: "b" }), contract({ id: "c" })]),
      runner,
      passGate,
    );
    expect(Math.max(...inflight)).toBe(3);
  });

  test("records unresolved findings per contract", async () => {
    const runner: WorkerRunner = { async run(c) { return ok(c.id); } };
    const out = await dispatch(
      plan([contract({ id: "a" }), contract({ id: "b" })]),
      runner,
      failGate,
      { maxRetries: 0 },
    );
    expect(out.unresolved).toHaveLength(2);
    expect(out.unresolved[0]).toContain("a —");
  });
});

describe("dispatch admission control", () => {
  test("never dispatches a contract the graph budget cannot fund", async () => {
    const seen: string[] = [];
    const runner: WorkerRunner = {
      async run(c) { seen.push(c.id); return ok(c.id); },
    };
    const out = await dispatch(
      {
        ...plan([contract({ id: "a" }), contract({ id: "b" }), contract({ id: "c" })]),
        graphBudget: { nodes: 2, edges: 16, tokens: 100000, wallMs: 600000 },
      },
      runner,
      passGate,
    );
    expect(seen).toEqual(["a", "b"]);
    expect(out.deferred).toEqual(["c"]);
  });

  test("a deferred contract is reported as unresolved, not silently dropped", async () => {
    const out = await dispatch(
      {
        ...plan([contract({ id: "a" })]),
        graphBudget: { nodes: 0, edges: 16, tokens: 100000, wallMs: 600000 },
      },
      { async run(c) { return ok(c.id); } },
      passGate,
    );
    expect(out.unresolved[0]).toContain("deferred");
    expect(out.accepted).toHaveLength(0);
  });

  test("reports budget exhaustion when the graph is spent", async () => {
    const out = await dispatch(
      {
        ...plan([contract({ id: "a" })]),
        graphBudget: { nodes: 1, edges: 16, tokens: 100000, wallMs: 600000 },
      },
      { async run(c) { return ok(c.id); } },
      passGate,
    );
    expect(out.budgetExhausted).toBe(true);
  });

  test("passes the attempt number so routing can escalate on retry", async () => {
    const attempts: number[] = [];
    const runner: WorkerRunner = {
      async run(c, attempt) { attempts.push(attempt ?? 0); return ok(c.id); },
    };
    await dispatch(plan([contract()]), runner, failGate);
    expect(attempts).toEqual([0, 1]);
  });
});

describe("shouldRetry", () => {
  test("retries a retryable failure", () => {
    expect(shouldRetry([{ gate: "verify", passed: false, detail: "", retryable: true }])).toBe(true);
  });

  test("does not retry a terminal failure", () => {
    expect(shouldRetry([{ gate: "scope", passed: false, detail: "", retryable: false }])).toBe(false);
  });

  test("does not retry when everything passed", () => {
    expect(shouldRetry([{ gate: "verify", passed: true, detail: "", retryable: false }])).toBe(false);
  });
});

describe("planPermissions", () => {
  test("produces rules for every contract", () => {
    const map = planPermissions(plan([contract({ id: "a" }), contract({ id: "b" })]));
    expect(Object.keys(map).sort()).toEqual(["a", "b"]);
  });
});

describe("aggregate", () => {

  test("attaches unresolved notes to the artifact that failed", () => {
    const out = aggregate(
      [ok("a"), { ...ok("b"), status: "failed" }],
      ["b — verify: exited 1"],
      { startedAt: "x", durationMs: 100, phases: [], workers: [], dispatchWallMs: 0, usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, topology: "fan-out" },
      ["b"],
    );
    expect(out.artifacts[0].unresolved).toEqual([]);
    expect(out.artifacts[1].unresolved).toEqual(["b — verify: exited 1"]);
  });

  test("reports a gate failure even when the session finished cleanly", () => {
    // The bug this covers: `status` says the session finished, which is not a
    // verdict. A worker whose checks all failed still finished cleanly, so
    // reading status as the verdict produced two components disagreeing --
    // "0 passed, 4 flagged" beside four artifacts listed as accepted.
    const out = aggregate(
      [ok("a"), ok("b")],
      ["b — verify: exited 1"],
      { startedAt: "x", durationMs: 100, phases: [], workers: [], dispatchWallMs: 0, usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, topology: "fan-out" },
      ["b"],
    );
    expect(out.artifacts[0].status).toBe("accepted");
    expect(out.artifacts[1].status).toBe("flagged");
    expect(out.artifacts[1].unresolved).toEqual(["b — verify: exited 1"]);
  });

  test("sums worker usage across artifacts", () => {
    const out = aggregate(
      [ok("a"), ok("b")],
      [],
      { startedAt: "x", durationMs: 100, phases: [], workers: [], dispatchWallMs: 0, usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, topology: "fan-out" },
    );
    expect(out.usage.input).toBe(200);
    expect(out.summary).toContain("fan-out");
  });
});
describe("review integration", () => {
  /**
   * Statefully simulates a worker weakening its own bar: the first snapshot is
   * the honest repo, every later snapshot is the tampered one. A stub that
   * returned a constant map would make before === after and hide every finding.
   */
  function tamperingRepo() {
    let snapshot = 0;
    return {
      anchors: () => {
        const value = snapshot++ === 0 ? "bun test" : "true";
        return new Map([["test", value]]);
      },
      testFiles: () => ["src/a.test.ts"],
    };
  }

  function steadyRepo() {
    return {
      anchors: () => new Map([["test", "bun test"]]),
      testFiles: () => ["src/a.test.ts"],
    };
  }

  test("no review findings without a repo source", async () => {
    const out = await dispatch(
      plan([contract()]),
      { async run(c) { return ok(c.id); } },
      failGate,
    );
    expect(out.reviewFindings).toEqual([]);
  });

  test("flags a worker that weakened a check during the retry", async () => {
    const out = await dispatch(
      plan([contract()]),
      { async run(c) { return ok(c.id); } },
      failGate,
      { repo: tamperingRepo() },
    );
    expect(out.reviewFindings.map((f) => f.code)).toEqual(["check-definition-moved"]);
    expect(out.reviewFindings[0].evidence).toContain("true");
  });

  test("flags removed test files on the retry", async () => {
    let snapshot = 0;
    const out = await dispatch(
      plan([contract()]),
      { async run(c) { return ok(c.id); } },
      failGate,
      {
        repo: {
          anchors: () => new Map([["test", "bun test"]]),
          testFiles: () => (snapshot++ === 0 ? ["src/a.test.ts", "src/b.test.ts"] : ["src/a.test.ts"]),
        },
      },
    );
    expect(out.reviewFindings.map((f) => f.code)).toContain("tests-removed");
    expect(out.reviewFindings[0].evidence).toContain("src/b.test.ts");
  });

  test("a clean retry produces no findings", async () => {
    const out = await dispatch(
      plan([contract()]),
      { async run(c) { return ok(c.id); } },
      failGate,
      { repo: steadyRepo() },
    );
    expect(out.reviewFindings).toEqual([]);
  });

  test("findings never trigger a further revision", async () => {
    let calls = 0;
    const out = await dispatch(
      plan([contract()]),
      { async run(c) { calls++; return ok(c.id); } },
      failGate,
      { repo: tamperingRepo() },
    );
    // Two runs: the failure and its one retry. A finding must not buy a third.
    expect(calls).toBe(2);
    expect(out.reviewFindings.length).toBeGreaterThan(0);
  });

  test("does not review when the gate failure is not retryable", async () => {
    let calls = 0;
    const out = await dispatch(
      plan([contract()]),
      { async run(c) { calls++; return ok(c.id, ["src/elsewhere.ts"]); } },
      passGate,
      { repo: tamperingRepo() },
    );
    expect(calls).toBe(1);
    expect(out.reviewFindings).toEqual([]);
  });
});

describe("dependency stages", () => {
  test("a consumer does not start until the producer it reads has landed", async () => {
    // The bug this covers: every contract ran at once, so a route importing
    // the shared types was checked against a module that did not exist yet.
    // The failure looked exactly like a defect and cost a full revise round.
    const order: string[] = [];
    const writes = new Set<string>();

    const producer = {
      id: "types",
      objective: "write the shared types",
      reads: [],
      writes: ["src/types.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: {},
      doneWhen: "types exist",
      checks: [],
      budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    };
    const consumer = {
      id: "route",
      objective: "write a route that imports the types",
      reads: ["src/types.ts"],
      writes: ["src/route.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: {},
      doneWhen: "route exists",
      checks: [],
      budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    };

    const plan = {
      topology: "pipeline",
      contracts: [consumer, producer],
      graphBudget: { nodes: 2, edges: 1, tokens: 2000, wallMs: 5000 },
    } as never;

    const runner = {
      async run(contract: { id: string; writes: string[] }) {
        order.push(`start:${contract.id}`);
        // A consumer that ran before its producer would find the module
        // missing. Record whether it was there.
        if (contract.id === "route") order.push(`types-present:${writes.has("src/types.ts")}`);
        for (const w of contract.writes) writes.add(w);
        order.push(`end:${contract.id}`);
        return {
          contractId: contract.id,
          status: "accepted" as const,
          changedFiles: contract.writes,
          artifact: { contractId: contract.id, deliverable: "diff", raw: "done" },
          usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          ms: 0,
          toolCalls: 0,
          cancelled: false,
        };
      },
    };

    await dispatch(plan, runner, { async run() { return { exitCode: 0, output: "" }; } });

    expect(order.indexOf("end:types")).toBeLessThan(order.indexOf("start:route"));
    expect(order).toContain("types-present:true");
  });

  test("independent contracts in one stage still run in parallel", async () => {
    const started: string[] = [];
    const contract = (id: string) => ({
      id,
      objective: "o",
      reads: [],
      writes: [`src/${id}.ts`],
      forbidden: [],
      deliverable: "diff",
      schema: {},
      doneWhen: "d",
      checks: [],
      budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    });

    const plan = {
      topology: "fan-out",
      contracts: [contract("a"), contract("b"), contract("c")],
      graphBudget: { nodes: 3, edges: 1, tokens: 3000, wallMs: 5000 },
    } as never;

    const runner = {
      async run(c: { id: string }) {
        started.push(c.id);
        await Bun.sleep(20);
        return {
          contractId: c.id,
          status: "accepted" as const,
          changedFiles: [],
          // An artifact is required: without one the schema gate fails and
          // the contract is re-run, which would double the call count.
          artifact: {
            contractId: c.id,
            deliverable: "diff",
            raw: "done",
          },
          usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          ms: 0,
          toolCalls: 0,
          cancelled: false,
        };
      },
    };

    await dispatch(plan, runner, { async run() { return { exitCode: 0, output: "" }; } });
    expect(started.sort()).toEqual(["a", "b", "c"]);
  });
});

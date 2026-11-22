import { describe, expect, test } from "bun:test";

import { dispatch } from "../../src/dispatch";
import type { Contract, Plan, WorkerResult } from "../../src/contracts/types";

function contract(): Contract {
  return {
    id: "core",
    objective: "build it",
    reads: [],
    writes: ["src/core.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: {},
    doneWhen: "it exists",
    checks: [{ id: "u", kind: "intent", command: "test", expectation: "e", gating: "blocking", convergent: true }],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 5000 },
  };
}

function plan(): Plan {
  return {
    mode: "full",
    topology: "fan-out",
    contracts: [contract()],
    graphBudget: { nodes: 4, edges: 8, tokens: 100000, wallMs: 600000 },
  };
}

function result(): WorkerResult {
  return {
    contractId: "core",
    status: "accepted",
    artifact: { contractId: "core", deliverable: "diff", raw: "done" },
    changedFiles: ["src/core.ts"],
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ms: 0,
    toolCalls: 0,
    cancelled: false,
  };
}

describe("mode-aware execute policy", () => {
  test("demo keeps one retry; full gets two", async () => {
    for (const [mode, expected] of [["demo", 2], ["full", 3]] as const) {
      let calls = 0;
      await dispatch(
        plan(),
        { async run() { calls++; return result(); } },
        { async run() { return { exitCode: 1, output: "FAIL" }; } },
        { mode },
      );
      expect(calls).toBe(expected);
    }
  });

  test("full checks the merged tree after a stage; demo does not", async () => {
    const runs: string[] = [];
    const gate = {
      async run(command: string) {
        runs.push(command);
        return { exitCode: 0, output: "" };
      },
    };
    await dispatch(plan(), { async run() { return result(); } }, gate, {
      mode: "full",
      integration: { command: "npm run build" },
    });
    expect(runs).toContain("npm run build");

    runs.length = 0;
    await dispatch(plan(), { async run() { return result(); } }, gate, {
      mode: "demo",
      integration: { command: "npm run build" },
    });
    expect(runs).not.toContain("npm run build");
  });

  test("full repairs a broken merged tree, demo never does", async () => {
    let buildCalls = 0;
    let workers = 0;
    const gate = {
      async run(command: string) {
        if (command === "npm run build") {
          buildCalls++;
          // First merged-tree check fails; the repair worker's check passes.
          return { exitCode: buildCalls >= 2 ? 0 : 1, output: buildCalls >= 2 ? "ok" : "broken" };
        }
        return { exitCode: 0, output: "" };
      },
    };
    const runner = {
      async run() {
        workers++;
        return result();
      },
    };
    const out = await dispatch(plan(), runner, gate, {
      mode: "full",
      integration: { command: "npm run build" },
    });
    expect(out.integrationRuns?.length).toBe(1);
    expect(out.integrationRuns?.[0].passed).toBe(false);
    expect(out.repair?.attempted).toBe(true);
    expect(out.repair?.passed).toBe(true);
    expect(workers).toBe(2); // the builder and the repair worker

    workers = 0;
    const demo = await dispatch(plan(), runner, gate, {
      mode: "demo",
      integration: { command: "npm run build" },
    });
    expect(demo.repair).toBeUndefined();
    expect(workers).toBe(1);
  });
});

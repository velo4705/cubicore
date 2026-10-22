import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cancelRun, describe as describeRun, loadRuns, pauseRun, resumeRun, startRun } from "../src/mcp/runs";
import { dispatch } from "../src/dispatch";
import type { Contract, Plan } from "../src/contracts/types";

/**
 * Nine commands were proposed and they all need the same thing: a run that
 * outlives the tool call, survives a restart, and can be stopped.
 *
 * The runs were in memory and process-local, so a cancelled run vanished, a
 * paused run could not be resumed, and a status poll could not say which
 * contracts had finished. All three are now on disk.
 */

const contract = (id: string, reads: string[] = []): Contract =>
  ({
    id,
    objective: "Do the thing",
    reads,
    writes: [`src/${id}.ts`],
    forbidden: [],
    deliverable: "diff",
    schema: { type: "object" },
    doneWhen: "done",
    checks: [
      {
        id: "k",
        kind: "intent",
        command: "test -f src/x.ts",
        expectation: "e",
        gating: "blocking",
        convergent: true,
      },
    ],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
  }) as unknown as Contract;

const planOf = (contracts: Contract[]): Plan =>
  ({
    topology: "fan-out",
    contracts,
    graphBudget: { nodes: contracts.length, edges: 1, tokens: 10_000, wallMs: 60_000 },
  }) as Plan;

describe("runs persist", () => {
  it("survives being read back from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-runs-"));
    const run = startRun(planOf([contract("a")]), dir);
    const found = loadRuns(dir).find((r) => r.id === run.id);
    expect(found).toBeDefined();
    expect(found!.progress).toHaveLength(1);
    expect(found!.progress[0].state).toBe("pending");
  });

  it("records every contract so progress is visible", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-runs-"));
    const run = startRun(planOf([contract("a"), contract("b"), contract("c")]), dir);
    const found = loadRuns(dir).find((r) => r.id === run.id)!;
    expect(found.progress.map((p) => p.contractId)).toEqual(["a", "b", "c"]);
  });
});

describe("cancel", () => {
  it("marks the unfinished work skipped and says why", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-runs-"));
    const run = startRun(planOf([contract("a"), contract("b")]), dir);
    const cancelled = cancelRun(run.id, dir, "the founder changed their mind")!;
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.cancelledBecause).toBe("the founder changed their mind");
    expect(cancelled.progress.every((p) => p.state === "skipped")).toBe(true);
  });

  it("actually stops the dispatch", async () => {
    // A cancel that only records the request is the same class of lie as a gate
    // that passes because it learned nothing.
    const dir = mkdtempSync(join(tmpdir(), "cubicore-runs-"));
    const run = startRun(planOf([contract("a"), contract("b")]), dir);
    cancelRun(run.id, dir, "stop");

    let dispatched = 0;
    const outcome = await dispatch(
      planOf([contract("a"), contract("b")]),
      {
        async run(c: Contract) {
          dispatched++;
          return {
            contractId: c.id,
            status: "accepted" as const,
            changedFiles: c.writes,
            artifact: { contractId: c.id, deliverable: "diff", raw: "x" },
            usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            ms: 1,
            toolCalls: 0,
            cancelled: false,
          };
        },
      },
      { async run() { return { exitCode: 0, output: "" }; } },
      { halt: () => "cancelled" },
    );

    expect(dispatched).toBe(0);
    expect(outcome.unresolved.join(" ")).toContain("cancelled");
  });
});

describe("pause and resume", () => {
  it("pauses a running run and resumes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-runs-"));
    const run = startRun(planOf([contract("a")]), dir);
    expect(pauseRun(run.id, dir)!.state).toBe("paused");
    expect(resumeRun(run.id, dir)!.state).toBe("running");
  });

  it("says so in the status text", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-runs-"));
    const run = startRun(planOf([contract("a")]), dir);
    const paused = pauseRun(run.id, dir)!;
    expect(describeRun(paused)).toContain("paused");
  });
});

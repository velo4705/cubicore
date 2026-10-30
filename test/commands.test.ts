import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cancelRun, describe as describeRun, loadRuns, pauseRun, startRun } from "../src/mcp/runs";
import { dispatch } from "../src/dispatch";
import { validateCrossPlan, validateCrossPlanInterfaces } from "../src/mcp/protocol";
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

  it("reports cancelled, not done", async () => {
    // A cancelled dispatch breaks out of the stage loop and returns normally,
    // so before the outcome carried the reason, the caller recorded it as a
    // finished run. A cancel that reports success is the same class of lie
    // as a gate that passes because it learned nothing.
    const dir = mkdtempSync(join(tmpdir(), "cubicore-runs-"));
    const run = startRun(planOf([contract("a")]), dir);
    cancelRun(run.id, dir, "stop");

    const outcome = await dispatch(
      planOf([contract("a")]),
      {
        async run(c: Contract) {
          return {
            contractId: c.id, status: "accepted" as const, changedFiles: c.writes,
            artifact: { contractId: c.id, deliverable: "diff", raw: "x" },
            usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            ms: 1, toolCalls: 0, cancelled: false,
          };
        },
      },
      { async run() { return { exitCode: 0, output: "" }; } },
      { halt: () => "cancelled" },
    );

    expect(outcome.halted).toBe("cancelled");
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

describe("pause", () => {
  it("holds a run without finishing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-runs-"));
    const run = startRun(planOf([contract("a")]), dir);
    const paused = pauseRun(run.id, dir)!;
    expect(paused.state).toBe("paused");
    expect(describeRun(paused)).toContain("paused");
  });
});

describe("refine does not re-run what already worked", () => {
  // Refining a plan to add a feature produces a plan containing every
  // contract -- the ones that passed and the new ones. Dispatching all of
  // them re-runs the ones that already worked, which is the whole cost of
  // the second cycle.
  it("skips a contract an earlier run satisfied and the refine left alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-refine-"));
    const plan = planOf([contract("a"), contract("b")]);
    const run = startRun(plan, dir);

    // Mark both contracts as done by that run.
    writeFileSync(
      join(dir, ".cubicore", "runs.json"),
      JSON.stringify([
        {
          ...run,
          state: "done",
          progress: [
            { contractId: "a", state: "done" },
            { contractId: "b", state: "done" },
          ],
        },
      ]),
    );

    let dispatched = 0;
    await dispatch(
      planOf([contract("a"), contract("b")]),
      {
        async run(c: Contract) {
          dispatched++;
          return {
            contractId: c.id, status: "accepted" as const, changedFiles: c.writes,
            artifact: { contractId: c.id, deliverable: "diff", raw: "x" },
            usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            ms: 1, toolCalls: 0, cancelled: false,
          };
        },
      },
      { async run() { return { exitCode: 0, output: "" }; } },
      { satisfiedContracts: ["a", "b"] },
    );

    expect(dispatched).toBe(0);
  });

  it("still runs a contract the refine changed", async () => {
    // Identical scope and checks means done. Different means it has to run
    // again -- the old result says nothing about the new contract.
    const dir = mkdtempSync(join(tmpdir(), "cubicore-refine-"));
    const plan = planOf([contract("a")]);
    const run = startRun(plan, dir);
    writeFileSync(
      join(dir, ".cubicore", "runs.json"),
      JSON.stringify([
        { ...run, state: "done", progress: [{ contractId: "a", state: "done" }] },
      ]),
    );

    let dispatched = 0;
    await dispatch(
      planOf([contract("a")]),
      {
        async run(c: Contract) {
          dispatched++;
          return {
            contractId: c.id, status: "accepted" as const, changedFiles: c.writes,
            artifact: { contractId: c.id, deliverable: "diff", raw: "x" },
            usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            ms: 1, toolCalls: 0, cancelled: false,
          };
        },
      },
      { async run() { return { exitCode: 0, output: "" }; } },
      // The refine changed the scope, so it is not satisfied.
      { satisfiedContracts: [] },
    );

    expect(dispatched).toBe(1);
  });
});

describe("cross-plan interface validation", () => {
  const writeFile = (dir: string, name: string, content: string) =>
    writeFileSync(join(dir, name), content);

  const planWith = (
    contracts: Array<{ id: string; reads: string[]; writes: string[] }>,
    context?: unknown,
  ) =>
    JSON.stringify({
      topology: "fan-out",
      contracts: contracts.map((c) => ({
        id: c.id,
        objective: `Do ${c.id}`,
        reads: c.reads,
        writes: c.writes,
        forbidden: [],
        deliverable: "diff",
        schema: { type: "object" },
        doneWhen: "done",
        checks: [
          {
            id: "k",
            kind: "intent",
            command: "test -f x",
            expectation: "e",
            gating: "blocking",
            convergent: true,
          },
        ],
        budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
      })),
      graphBudget: { nodes: contracts.length, edges: 0, tokens: 10_000, wallMs: 60_000 },
      ...(context ? { context } : {}),
    });

  it("reports no problems when every read is satisfied by some write", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-cross-"));
    // Each plan has one contract (fan-out = independent within plan).
    // Cross-plan: plan 2 reads what plan 1 writes, plan 3 reads what plan 2 writes.
    writeFile(dir, "CUBICORE_PLAN_1.json", planWith([
      { id: "a", reads: [], writes: ["src/api.ts"] },
    ]));
    writeFile(dir, "CUBICORE_PLAN_2.json", planWith([
      { id: "b", reads: ["src/api.ts"], writes: ["src/app.ts"] },
    ]));
    writeFile(dir, "CUBICORE_PLAN_3.json", planWith([
      { id: "c", reads: ["src/app.ts"], writes: ["src/ui.ts"] },
    ]));

    const problems = validateCrossPlanInterfaces(dir);
    expect(problems).toEqual([]);
  });

  it("reports orphan reads when no plan writes a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-cross-"));
    writeFile(dir, "CUBICORE_PLAN_1.json", planWith([
      { id: "a", reads: [], writes: ["src/api.ts"] },
    ]));
    writeFile(dir, "CUBICORE_PLAN_2.json", planWith([
      { id: "b", reads: ["src/missing.ts"], writes: ["src/app.ts"] },
    ]));

    const problems = validateCrossPlanInterfaces(dir);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("orphan read");
    expect(problems[0]).toContain("src/missing.ts");
  });

  it("returns empty when fewer than 2 plan files exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-cross-"));
    writeFile(dir, "CUBICORE_PLAN_1.json", planWith([
      { id: "a", reads: [], writes: ["src/api.ts"] },
    ]));

    const problems = validateCrossPlanInterfaces(dir);
    expect(problems).toEqual([]);
  });

  it("validateCrossPlan combines collisions and interface checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-cross-"));
    // Two plans both writing the same file -> collision
    writeFile(dir, "CUBICORE_PLAN_1.json", planWith([
      { id: "a", reads: [], writes: ["src/shared.ts"] },
    ]));
    writeFile(dir, "CUBICORE_PLAN_2.json", planWith([
      { id: "b", reads: [], writes: ["src/shared.ts"] },
    ]));

    const problems = validateCrossPlan(dir);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes("write collision"))).toBe(true);
  });

  it("validateCrossPlan passes when plans are mutually compatible", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-cross-"));
    writeFile(dir, "CUBICORE_PLAN_1.json", planWith([
      { id: "a", reads: [], writes: ["src/api.ts"] },
    ]));
    writeFile(dir, "CUBICORE_PLAN_2.json", planWith([
      { id: "b", reads: ["src/api.ts"], writes: ["src/app.ts"] },
    ]));

    const problems = validateCrossPlan(dir);
    expect(problems).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";

import { describe as renderRun } from "../../src/mcp/runs";
import type { Run } from "../../src/mcp/runs";

const runWith = (progress: Run["progress"], contracts: Array<Record<string, unknown>>): Run =>
  ({
    id: "run-1",
    startedAt: Date.now() - 10_000,
    plan: { contracts } as unknown as Run["plan"],
    state: "running",
    progress,
    directory: "/tmp",
  } as unknown as Run);

describe("describe — worker states with real data only", () => {
  const contracts = [{ id: "world", writes: [] as string[] }];

  test("a plan with steps shows the steps tally", () => {
    const run = runWith(
      [{ contractId: "world", state: "running", steps: { parse: "done", render: "pending" } }],
      contracts,
    );
    expect(renderRun(run)).toContain("Steps: 1/2 done");
  });

  test("all steps done reads 2/2 done", () => {
    const run = runWith(
      [{ contractId: "world", state: "done", steps: { parse: "done", render: "done" } }],
      contracts,
    );
    expect(renderRun(run)).toContain("Steps: 2/2 done");
  });

  test("a plan without steps shows no steps line", () => {
    const run = runWith([{ contractId: "world", state: "running" }], contracts);
    expect(renderRun(run)).not.toContain("Steps:");
  });

  test("a multi-contract run prints the union-attribution footer", () => {
    const run = runWith(
      [
        { contractId: "a", state: "done" },
        { contractId: "b", state: "running" },
      ],
      [{ id: "a", writes: [] as string[] }, { id: "b", writes: [] as string[] }],
    );
    expect(renderRun(run)).toContain("Attribution: union");
  });
});

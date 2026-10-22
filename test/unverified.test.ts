import { describe, expect, it } from "bun:test";

import { runGates } from "../src/gate";
import type { Contract } from "../src/contracts/types";

/**
 * "If a test cannot run because a dependency is unavailable, record it as
 * BLOCKED or UNVERIFIED. Never report it as PASSED without evidence."
 *
 * The second half we already satisfy: a check is only passed after its
 * command has run and exited zero. The first half we did not: a missing tool
 * was reported as a failure, which is both a mislabel and a waste, because a
 * revision cannot install a dependency.
 */

const contract = (check: string): Contract =>
  ({
    id: "w1",
    objective: "Do the thing",
    reads: [],
    writes: ["src/a.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: { type: "object" },
    doneWhen: "done",
    checks: [
      {
        id: "k",
        kind: "intent",
        command: check,
        expectation: "e",
        gating: "blocking",
        convergent: true,
      },
    ],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
  }) as unknown as Contract;

const run = (exitCode: number, output: string) =>
  runGates(
    { artifact: { contractId: "w1", deliverable: "diff", raw: "x" }, contract: contract("some check") },
    { async run() { return { exitCode, output }; } },
    { changedFiles: ["src/a.ts"] },
  );

describe("a check that could not run is unverified, not failed", () => {
  it("reports a missing command as unverified and does not retry it", async () => {
    const gates = await run(127, "sh: 1: tsc: not found");
    const verify = gates.find((g) => g.gate === "verify")!;
    expect(verify.passed).toBe(false);
    expect(verify.unverified).toBe(true);
    expect(verify.retryable).toBe(false);
    expect(verify.detail).toContain("unverified");
  });

  it("reports a missing module as unverified", async () => {
    const gates = await run(1, "Error: Cannot find module 'vitest'");
    const verify = gates.find((g) => g.gate === "verify")!;
    expect(verify.unverified).toBe(true);
  });

  it("still reports a real failure as a failure, and still retries it", async () => {
    const gates = await run(1, "AssertionError: expected 1 to be 2");
    const verify = gates.find((g) => g.gate === "verify")!;
    expect(verify.passed).toBe(false);
    expect(verify.unverified).toBeUndefined();
    expect(verify.retryable).toBe(true);
  });

  it("never passes a check that did not run", async () => {
    for (const [code, output] of [[127, "not found"], [1, "Cannot find module 'x'"]] as const) {
      const gates = await run(code, output);
      // The schema and scope gates legitimately pass -- the artifact is fine
      // and nothing strayed. It is the verify gate that must not.
      const verify = gates.find((g) => g.gate === "verify")!;
      expect(verify.passed).toBe(false);
      expect(verify.unverified).toBe(true);
    }
  });
});

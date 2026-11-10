import { describe, expect, test } from "bun:test";
import { parsePlan, MalformedPlan } from "../src/coordinator/parse";
import { buildRetrospective } from "../src/factory/retrospect";
import type { Plan } from "../src/contracts/types";

const VALID = {
  topology: "fan-out",
  contracts: [{
    id: "w", objective: "do the thing", reads: [], writes: ["src/a.ts"], forbidden: [],
    deliverable: "diff", schema: {}, doneWhen: "a compiles",
    checks: [{ id: "c", kind: "intent", command: "true", expectation: "ok", gating: "blocking", convergent: true }],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 60_000 },
  }],
  graphBudget: { nodes: 2, edges: 0, tokens: 1000, wallMs: 1000 },
};

describe("integration block", () => {
  test("a plan with a whole-tree integration command parses and round-trips", () => {
    const withInt = parsePlan(JSON.stringify({ ...VALID, integration: { command: "npm run build", timeoutMs: 120000 } })) as Plan;
    expect(withInt.integration).toEqual({ command: "npm run build", timeoutMs: 120000 });
    const back = parsePlan(JSON.stringify(withInt)) as Plan;
    expect(back.integration?.command).toBe("npm run build");
  });

  test("an absent integration block is fine", () => {
    const p = parsePlan(JSON.stringify(VALID)) as Plan;
    expect(p.integration).toBeUndefined();
  });

  test("an out-of-bounds timeout is rejected", () => {
    expect(() => parsePlan(JSON.stringify({ ...VALID, integration: { command: "npm run build", timeoutMs: 9_999_999 } }))).toThrow(MalformedPlan);
  });

  test("a missing command is rejected", () => {
    expect(() => parsePlan(JSON.stringify({ ...VALID, integration: { command: "" } }))).toThrow(MalformedPlan);
  });
});

describe("retrospect integration line", () => {
  const artifacts = [{ contractId: "w0", status: "done", deliverable: "diff", changedFiles: [], unresolved: [], unverified: false }];
  const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  test("integration passed is acknowledged in the verdict", () => {
    const r = buildRetrospective({ fit: undefined, artifacts, unresolved: [], deferred: 0, usage, integration: { passed: true } });
    expect(r.verdict).toMatch(/merged tree/i);
    expect(r.integration?.passed).toBe(true);
  });
  test("integration failure produces a ship-blocking verdict", () => {
    const r = buildRetrospective({ fit: undefined, artifacts, unresolved: [], deferred: 0, usage, integration: { passed: false, output: "exit 1\nError: cannot find module" } });
    expect(r.verdict).toMatch(/FAILED/);
  });
});

describe("unverified vs failed — distinction the founder sees", () => {
  test("unverified work is labeled blocked in the artifact, not flagged", () => {
    const artifacts = [
      { contractId: "w0", status: "blocked", deliverable: "diff", changedFiles: [], unresolved: ["w0 — verify: check \"k\" could not run (exit 127):"], unverified: true },
      { contractId: "w1", status: "done", deliverable: "diff", changedFiles: [], unresolved: [], unverified: false },
    ];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const r = buildRetrospective({ fit: undefined, artifacts: artifacts as never, unresolved: [], deferred: 0, usage });
    expect(r.blocked).toBe(1);
    expect(r.verdict).toMatch(/could not be verified/i);
  });
});

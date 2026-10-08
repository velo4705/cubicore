import { describe, expect, test } from "bun:test";
import { UsageLedger } from "../../src/telemetry/usage";
import type { TokenUsage } from "../../src/telemetry/types";

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 100,
    output: 50,
    reasoning: 10,
    cacheRead: 800,
    cacheWrite: 0,
    cost: 0.01,
    ...overrides,
  };
}

describe("UsageLedger", () => {
  test("records a new key once", () => {
    const ledger = new UsageLedger();
    expect(ledger.record("s1", "msg1", usage())).toBe(true);
    expect(ledger.totalUsage().input).toBe(100);
  });

  test("discards a repeated key, which is the normal streaming case", () => {
    const ledger = new UsageLedger();
    ledger.record("s1", "msg1", usage());
    expect(ledger.record("s1", "msg1", usage())).toBe(false);
    expect(ledger.totalUsage().input).toBe(100);
    expect(ledger.duplicateCount()).toBe(1);
  });

  test("does not collapse the same key under two different scopes", () => {
    const ledger = new UsageLedger();
    ledger.record("worker-a", "msg1", usage());
    ledger.record("worker-b", "msg1", usage());
    expect(ledger.totalUsage().input).toBe(200);
  });

  test("aggregates per scope", () => {
    const ledger = new UsageLedger();
    ledger.record("a", "m1", usage({ input: 10 }));
    ledger.record("a", "m2", usage({ input: 15 }));
    ledger.record("b", "m1", usage({ input: 100 }));
    expect(ledger.forScope("a").input).toBe(25);
    expect(ledger.forScope("b").input).toBe(100);
    expect(ledger.forScope("missing").input).toBe(0);
    expect(ledger.scopes().sort()).toEqual(["a", "b"]);
  });

  test("bounds its dedupe set to the most recent keys", () => {
    const ledger = new UsageLedger(4);
    for (let i = 0; i < 20; i++) ledger.record("s", `m${i}`, usage());

    // The four newest survive, so those still dedupe.
    expect(ledger.record("s", "m19", usage())).toBe(false);
    expect(ledger.record("s", "m18", usage())).toBe(false);
    // The oldest were evicted to make room, so they are re-countable.
    expect(ledger.record("s", "m0", usage())).toBe(true);
  });

  test("a duplicate never double-counts cost", () => {
    const ledger = new UsageLedger();
    ledger.record("s", "m", usage({ cost: 0.5 }));
    ledger.record("s", "m", usage({ cost: 0.5 }));
    expect(ledger.totalUsage().cost).toBe(0.5);
  });
});
import { describe, expect, test } from "bun:test";
import { analyseRun, compare } from "../../src/telemetry/analysis";
import { cacheHitRate, totalTokens, type RunReport, type TokenUsage } from "../../src/telemetry/types";

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...overrides };
}

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 10_000,
    phases: [
      { phase: "plan", ms: 1_500 },
      { phase: "validate", ms: 100 },
      { phase: "dispatch", ms: 4_000 },
      { phase: "aggregate", ms: 2_000 },
    ],
    workers: [
      { contractId: "w1", ms: 10_000, usage: usage({ input: 100, output: 20 }), toolCalls: 3 },
      { contractId: "w2", ms: 10_000, usage: usage({ input: 100, output: 20 }), toolCalls: 3 },
    ],
    dispatchWallMs: 4_000,
    usage: usage({ input: 300, output: 100, cacheRead: 400, cost: 0.2 }),
    topology: "fan-out",
    ...overrides,
  };
}

describe("token maths", () => {
  test("totalTokens counts cache reads because they still bill", () => {
    expect(totalTokens(usage({ input: 1, output: 2, cacheRead: 8 }))).toBe(11);
  });

  test("cacheHitRate divides by total input-side volume", () => {
    expect(cacheHitRate(usage({ input: 100, cacheRead: 300 }))).toBeCloseTo(0.75);
  });

  test("cacheHitRate is zero with no traffic, not NaN", () => {
    expect(cacheHitRate(usage())).toBe(0);
  });
});

describe("analyseRun", () => {
  test("serial time excludes the dispatch phase", () => {
    expect(analyseRun(report()).serialMs).toBe(3_600);
  });

  test("parallelism is worker time over dispatch span", () => {
    // 20s of work finished in 4s of wall time => ~5x concurrent.
    expect(analyseRun(report()).parallelism).toBeCloseTo(5);
  });

  test("serialFraction is the Amdahl input", () => {
    expect(analyseRun(report()).serialFraction).toBeCloseTo(0.36);
  });

  test("a dispatch that never overlaps reports parallelism near 1", () => {
    const serialised = report({ dispatchWallMs: 20_000 });
    expect(analyseRun(serialised).parallelism).toBeCloseTo(1);
  });

  test("a zero dispatch span does not produce Infinity", () => {
    const metrics = analyseRun(report({ dispatchWallMs: 0 }));
    expect(metrics.parallelism).toBe(0);
    expect(Number.isFinite(metrics.parallelism)).toBe(true);
  });
});

describe("compare", () => {
  const baseline = { durationMs: 30_000, usage: usage({ input: 2000, output: 400, cost: 1 }) };

  test("speedup is baseline over observed", () => {
    expect(compare(baseline, report()).speedup).toBeCloseTo(3);
  });

  test("tokenRatio reports orchestration above or below the baseline honestly", () => {
    // run spends 800 tokens against a 2400-token baseline.
    expect(compare(baseline, report()).tokenRatio).toBeCloseTo(800 / 2400);
    // a zero baseline yields 0, not NaN
    expect(compare({ durationMs: 1, usage: usage() }, report()).tokenRatio).toBe(0);
  });

  test("naiveFanoutRatio is the Y claim against N full-context workers", () => {
    // workers spend 240 tokens total; naive 2 workers would each pay 2400.
    const y = compare(baseline, report()).naiveFanoutRatio;
    expect(y).toBeCloseTo(0.05);
  });

  test("perWorkerTokenReduction is mean worker cost vs the baseline total", () => {
    // mean worker = 120 tokens against a 2400-token baseline.
    expect(compare(baseline, report()).perWorkerTokenReduction).toBeCloseTo(0.95);
  });

  test("amdahlCeiling is 1 over the serial fraction", () => {
    expect(compare(baseline, report()).amdahlCeiling).toBeCloseTo(1 / 0.36);
  });

  test("a run with no workers does not divide by zero", () => {
    const empty = report({ workers: [] });
    const result = compare(baseline, empty);
    expect(result.perWorkerTokenReduction).toBe(1);
    expect(result.parallelism).toBe(0);
    expect(Number.isFinite(result.naiveFanoutRatio)).toBe(true);
  });
});
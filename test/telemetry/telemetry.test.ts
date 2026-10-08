import { describe, expect, test } from "bun:test";
import { PhaseTimer } from "../../src/telemetry/timing";
import { RunRecorder, summarise } from "../../src/telemetry/report";
import { readUsage } from "../../src/telemetry/adapters/opencode";

function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("PhaseTimer", () => {
  test("measures a phase", () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    timer.start("plan");
    clock.advance(1500);
    expect(timer.stop("plan")).toBe(1500);
  });

  test("rejects starting a phase twice", () => {
    const timer = new PhaseTimer(fakeClock().now);
    timer.start("plan");
    expect(() => timer.start("plan")).toThrow();
  });

  test("rejects stopping a phase that never started", () => {
    const timer = new PhaseTimer(fakeClock().now);
    expect(() => timer.stop("aggregate")).toThrow();
  });

  test("around stops the phase even when the body throws", async () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    await expect(
      timer.around("validate", () => {
        clock.advance(100);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(timer.running()).toEqual([]);
  });

  test("around returns the body's value", async () => {
    const timer = new PhaseTimer(fakeClock().now);
    expect(await timer.around("plan", async () => 42)).toBe(42);
  });
});

describe("RunRecorder", () => {
  test("derives duration and dispatch span from the phase log", () => {
    const clock = fakeClock();
    const recorder = new RunRecorder("fan-out", new PhaseTimer(clock.now));

    recorder.start("plan");
    clock.advance(1000);
    recorder.stop("plan");

    recorder.start("dispatch");
    clock.advance(4000);
    recorder.stop("dispatch");

    recorder.start("aggregate");
    clock.advance(1000);
    recorder.stop("aggregate");

    const run = recorder.finish({
      input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1,
    });

    expect(run.durationMs).toBe(6000);
    expect(run.dispatchWallMs).toBe(4000);
    expect(run.topology).toBe("fan-out");
  });

  test("summarise renders a one-line CI summary", () => {
    const line = summarise(
      {
        startedAt: "x", durationMs: 6000,
        phases: [], workers: [], dispatchWallMs: 0,
        usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        topology: "fan-out",
      },
      { speedup: 3, tokenRatio: 1.2, naiveFanoutRatio: 0.5, parallelism: 4, serialFraction: 0.25, amdahlCeiling: 4, cacheHitRate: 0.5 },
    );
    expect(line).toContain("fan-out");
    expect(line).toContain("speedup 3.00x");
    expect(line).toContain("vs naive fan-out 50%");
  });
});

describe("opencode adapter", () => {
  test("reads a flat token block", () => {
    const usage = readUsage({
      role: { type: "assistant" },
      tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 100, cacheWrite: 20, cost: 0.03 },
    });
    expect(usage).toEqual({ input: 10, output: 5, reasoning: 2, cacheRead: 100, cacheWrite: 20, cost: 0.03 });
  });

  test("reads a nested cache block", () => {
    const usage = readUsage({
      role: { type: "assistant" },
      tokens: { input: 10, output: 5, cache: { read: 100, write: 20 } },
    });
    expect(usage?.cacheRead).toBe(100);
    expect(usage?.cacheWrite).toBe(20);
    expect(usage?.cost).toBe(0);
  });

  test("ignores non-assistant messages", () => {
    expect(readUsage({ role: { type: "user" }, tokens: { input: 10 } })).toBeNull();
  });

  test("ignores events with no token block", () => {
    expect(readUsage({ role: { type: "assistant" } })).toBeNull();
    expect(readUsage({ tokens: {} })).toBeNull();
    expect(readUsage(null)).toBeNull();
    expect(readUsage("nonsense")).toBeNull();
  });
});
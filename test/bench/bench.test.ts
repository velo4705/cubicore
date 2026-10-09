import { describe, expect, test } from "bun:test";
import {
  SPREAD_TOLERANCE,
  armReport,
  inspectRun,
  pairTrials,
  summariseClaim,
  summariseTrials,
} from "../../src/bench/aggregate";
import { BenchTimeout, runTask, splitForFanOut, type BenchOptions } from "../../src/bench/runner";
import type { TokenUsage } from "../../src/telemetry/types";
import type { ArmName, Trial } from "../../src/bench/types";

function usage(tokens: number): TokenUsage {
  return { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: tokens / 100_000 };
}

function trial(overrides: Partial<Trial> = {}): Trial {
  return {
    taskId: "t1",
    arm: "single",
    durationMs: 1000,
    usage: usage(1000),
    ...overrides,
  };
}

describe("summariseTrials", () => {
  test("uses the median, so one outlier cannot move the result", () => {
    const trials = [100, 110, 120, 90, 100_000].map((ms) => trial({ durationMs: ms }));
    expect(summariseTrials(trials).medianMs).toBe(110);
  });

  test("reports spread alongside the median", () => {
    const stats = summariseTrials([trial({ durationMs: 100 }), trial({ durationMs: 300 })]);
    expect(stats.spreadMs).toBe(100);
    expect(stats.medianMs).toBe(200);
  });

  test("counts timeouts separately rather than averaging them in", () => {
    const stats = summariseTrials([
      trial({ durationMs: 100 }),
      trial({ durationMs: 0, timedOut: true }),
    ]);
    expect(stats.timeouts).toBe(1);
    expect(stats.medianMs).toBe(50);
  });

  test("handles an empty arm without NaN", () => {
    const stats = summariseTrials([]);
    expect(stats.n).toBe(0);
    expect(stats.medianMs).toBe(0);
    expect(Number.isFinite(stats.medianCost)).toBe(true);
  });
});

describe("pairTrials", () => {
  test("pairs within a task, not across the corpus", () => {
    const pairs = pairTrials(
      [trial({ taskId: "t1", durationMs: 500 }), trial({ taskId: "t2", durationMs: 2000 })],
      [trial({ taskId: "t1", durationMs: 1000 }), trial({ taskId: "t2", durationMs: 1000 })],
    );
    expect(pairs).toHaveLength(2);
    expect(pairs.find((p) => p.taskId === "t1")?.ratio).toBeCloseTo(0.5);
  });

  test("takes the median of repeats within a task", () => {
    const pairs = pairTrials(
      [trial({ durationMs: 400 }), trial({ durationMs: 600 }), trial({ durationMs: 800 })],
      [trial({ durationMs: 1000 })],
    );
    expect(pairs[0].ratio).toBeCloseTo(0.6);
  });

  test("skips tasks with no baseline rather than inventing one", () => {
    const pairs = pairTrials([trial({ taskId: "t2" })], [trial({ taskId: "t1" })]);
    expect(pairs).toHaveLength(0);
  });
});

describe("summariseClaim", () => {
  test("a consistent speedup across tasks is stable", () => {
    const pairs = ["a", "b", "c"].map((taskId) => ({
      taskId,
      baselineMs: 1000,
      candidateMs: 400,
      ratio: 0.4,
    }));
    const claim = summariseClaim(pairs);
    expect(claim.speedup).toBeCloseTo(0.4);
    expect(claim.stable).toBe(true);
    expect(claim.tasks).toBe(3);
  });

  test("a speedup that flips between tasks is refused as unstable", () => {
    const pairs = [
      { taskId: "a", baselineMs: 1000, candidateMs: 100, ratio: 0.1 },
      { taskId: "b", baselineMs: 1000, candidateMs: 900, ratio: 0.9 },
    ];
    const claim = summariseClaim(pairs);
    expect(claim.stable).toBe(false);
    expect(claim.speedupSpread).toBeCloseTo(0.4);
  });

  test("no trials produces no claim rather than a zero one", () => {
    const claim = summariseClaim([]);
    expect(claim.tasks).toBe(0);
    expect(claim.speedup).toBe(0);
    expect(claim.stable).toBe(false);
  });

  test("reports the range so a single wild task is visible", () => {
    const pairs = [
      { taskId: "a", baselineMs: 1, candidateMs: 1, ratio: 5 },
      { taskId: "b", baselineMs: 1, candidateMs: 1, ratio: 0.5 },
      { taskId: "c", baselineMs: 1, candidateMs: 1, ratio: 0.6 },
    ];
    expect(summariseClaim(pairs).speedupRange).toEqual([0.5, 5]);
  });

  test("the stability threshold is documented, not magic", () => {
    const pairs = [
      { taskId: "a", baselineMs: 1, candidateMs: 1, ratio: 1 },
      { taskId: "b", baselineMs: 1, candidateMs: 1, ratio: 1 - SPREAD_TOLERANCE / 2 },
    ];
    expect(summariseClaim(pairs).stable).toBe(true);
  });
});

describe("armReport", () => {
  test("the single arm carries no comparative claim", () => {
    expect(armReport("single", [trial()], [trial()]).claim).toBeUndefined();
  });

  test("the orchestrated arm is compared against single", () => {
    const report = armReport(
      "orchestrated",
      [trial({ durationMs: 400 })],
      [trial({ durationMs: 1000 })],
    );
    expect(report.claim?.speedup).toBeCloseTo(0.4);
  });
});

describe("runTask", () => {
  const scripted: BenchOptions = {
    repetitions: 2,
    tokens: { async read() { return usage(1000); } },
    run: {
      async run() {
        return { sessionId: "ses_x", durationMs: 500 };
      },
    },
  };

  test("runs every arm every repetition", async () => {
    const seen: ArmName[] = [];
    const trials = await runTask(
      { id: "t1", prompt: "p", expectedWorkers: 3 },
      { ...scripted, run: { async run(r) { seen.push(r.arm); return { sessionId: "s", durationMs: 1 }; } } },
    );
    expect(trials).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set(["single", "naive-fanout", "orchestrated"]));
  });

  test("interleaves arms rather than blocking by arm", async () => {
    const order: string[] = [];
    await runTask(
      { id: "t1", prompt: "p", expectedWorkers: 2 },
      { ...scripted, run: { async run(r) { order.push(r.arm); return { sessionId: "s", durationMs: 1 }; } } },
    );
    expect(order.slice(0, 3)).toEqual(["single", "naive-fanout", "orchestrated"]);
  });

  test("only the naive arm receives chunks", async () => {
    const withChunks: Record<string, number> = {};
    await runTask(
      { id: "t1", prompt: "p", expectedWorkers: 4 },
      {
        ...scripted,
        run: {
          async run(r) {
            withChunks[r.arm] = r.chunks?.length ?? 0;
            return { sessionId: "s", durationMs: 1 };
          },
        },
      },
    );
    expect(withChunks).toEqual({ single: 0, "naive-fanout": 4, orchestrated: 0 });
  });

  test("a timed-out trial is recorded with no usage, not thrown", async () => {
    const trials = await runTask(
      { id: "t1", prompt: "p", expectedWorkers: 1 },
      {
        ...scripted,
        repetitions: 1,
        run: {
          async run(request) {
            // Simulate the harness's own timeout firing.
            const raced = Promise.race([
              Promise.reject(new BenchTimeout()),
              new Promise((_, reject) =>
                setTimeout(() => reject(new BenchTimeout()), request.timeoutMs ?? 1000),
              ),
            ]);
            return raced as never;
          },
        },
      },
    );
    expect(trials).toHaveLength(3);
    expect(trials.every((trial) => trial.timedOut)).toBe(true);
    expect(trials[0].usage.input).toBe(0);
  });

  test("propagates a non-timeout runner failure", async () => {
    let threw = false;
    await runTask(
      { id: "t1", prompt: "p", expectedWorkers: 1 },
      { ...scripted, repetitions: 1, run: { async run() { throw new Error("boom"); } } },
    ).catch(() => {
      threw = true;
    });
    expect(threw).toBe(true);
  });
});

describe("splitForFanOut", () => {
  test("gives every worker the full prompt, which is what full context costs", () => {
    const chunks = splitForFanOut({ prompt: "audit 8 files" }, 3);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk).toContain("audit 8 files");
  });

  test("never returns zero workers", () => {
    expect(splitForFanOut({ prompt: "p" }, 0)).toHaveLength(1);
  });
});

describe("inspectRun", () => {
  test("reuses the single implementation of the Amdahl arithmetic", () => {
    const result = inspectRun(
      {
        startedAt: "x",
        durationMs: 1000,
        phases: [{ phase: "plan", ms: 250 }, { phase: "dispatch", ms: 750 }],
        workers: [],
        dispatchWallMs: 750,
        usage: usage(100),
        topology: "fan-out",
      },
      { durationMs: 2000, usage: usage(200) },
    );
    expect(result.speedup).toBeCloseTo(2);
    expect(result.amdahlCeiling).toBeCloseTo(4);
  });
});
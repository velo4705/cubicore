import {
  cacheHitRate as hitRate,
  totalTokens,
  type Comparison,
  type RunReport,
  type TokenUsage,
} from "./types";

export interface RunMetrics {
  serialMs: number;
  parallelWallMs: number;
  workerSumMs: number;
  /**
   * workerSumMs / dispatchWallMs. Roughly the number of workers that were
   * actually concurrent. ~1 means dispatch serialised and fan-out bought
   * nothing, which is the failure this metric exists to catch.
   */
  parallelism: number;
  serialFraction: number;
  totalTokens: number;
  cacheHitRate: number;
  cost: number;
}

/** What a single agent costs doing the same work with no orchestration. */
export interface BaselineRun {
  durationMs: number;
  usage: TokenUsage;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export function analyseRun(report: RunReport): RunMetrics {
  const serialMs = report.phases
    .filter((timing) => timing.phase !== "dispatch")
    .reduce((sum, timing) => sum + timing.ms, 0);

  const workerSumMs = report.workers.reduce((sum, worker) => sum + worker.ms, 0);

  return {
    serialMs,
    parallelWallMs: report.dispatchWallMs,
    workerSumMs,
    parallelism: ratio(workerSumMs, report.dispatchWallMs),
    serialFraction: ratio(serialMs, report.durationMs),
    totalTokens: totalTokens(report.usage),
    cacheHitRate: hitRate(report.usage),
    cost: report.usage.cost,
  };
}

/**
 * X and Y from the pitch. Both require a measured baseline; neither is
 * derivable from a single run, which is why `Comparison` is a separate type.
 */
export function compare(baseline: BaselineRun, report: RunReport): Comparison {
  const metrics = analyseRun(report);
  const baselineTokens = totalTokens(baseline.usage);
  const workerTokens = report.workers.reduce(
    (sum, worker) => sum + totalTokens(worker.usage),
    0,
  );
  const workerCount = report.workers.length;

  const meanWorkerTokens = workerCount === 0 ? 0 : workerTokens / workerCount;
  const naiveFanoutTokens = baselineTokens * Math.max(workerCount, 1);

  return {
    baselineMs: baseline.durationMs,
    baselineTokens,
    baselineCost: baseline.usage.cost,

    speedup: ratio(baseline.durationMs, report.durationMs),
    tokenRatio: ratio(metrics.totalTokens, baselineTokens),
    costRatio: ratio(report.usage.cost, baseline.usage.cost),

    perWorkerTokenReduction: 1 - ratio(meanWorkerTokens, baselineTokens),
    naiveFanoutRatio: ratio(workerTokens, naiveFanoutTokens),
    cacheHitRate: metrics.cacheHitRate,

    parallelism: metrics.parallelism,
    serialFraction: metrics.serialFraction,
    amdahlCeiling: ratio(1, metrics.serialFraction),
  };
}
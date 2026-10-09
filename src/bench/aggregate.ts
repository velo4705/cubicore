import { totalTokens, type Comparison, type RunReport } from "../telemetry/types";
import { analyseRun, compare, type BaselineRun } from "../telemetry/analysis";
import type { ArmName, Trial, TrialStats } from "./types";

/**
 * Turning trials into a claim.
 *
 * Three deliberate choices, each of which changes the answer:
 *
 * 1. **Median, not mean.** Agent durations are heavy-tailed. One retry storm
 *    skews a mean enough to make a regression look like noise.
 * 2. **Paired ratios, not ratio of medians.** Every task is run under every arm,
 *    so the comparison is within-task. A ratio of medians across arms conflates
 *    "Cubicore is faster" with "this task happened to be slow for everyone".
 * 3. **Spread is reported alongside the median.** A 2x speedup with a 4x spread
 *    is not a speedup. Reporting the median alone would hide that.
 *
 * Derived figures (what the speedup *would* be under perfect parallelism) are
 * included because they are free and because a measured figure far below its
 * derived figure is the clearest signal that fan-out is not actually happening.
 */

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Median absolute deviation. Robust where a standard deviation is not. */
function mad(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

export function summariseTrials(trials: readonly Trial[]): TrialStats {
  const durations = trials.map((trial) => trial.durationMs);
  const tokens = trials.map((trial) => totalTokens(trial.usage));
  const costs = trials.map((trial) => trial.usage.cost);

  return {
    n: trials.length,
    medianMs: median(durations),
    medianTokens: median(tokens),
    medianCost: median(costs),
    spreadMs: mad(durations),
    minMs: durations.length > 0 ? Math.min(...durations) : 0,
    maxMs: durations.length > 0 ? Math.max(...durations) : 0,
    timeouts: trials.filter((trial) => trial.timedOut).length,
  };
}

export interface PairedRatio {
  taskId: string;
  ratio: number;
  baselineMs: number;
  candidateMs: number;
}

export function pairTrials(
  candidate: readonly Trial[],
  baseline: readonly Trial[],
): PairedRatio[] {
  const byTask = new Map<string, Trial[]>();
  for (const trial of candidate) {
    const list = byTask.get(trial.taskId) ?? [];
    list.push(trial);
    byTask.set(trial.taskId, list);
  }

  const pairs: PairedRatio[] = [];
  for (const [taskId, candidateTrials] of byTask) {
    const baselineTrials = baseline.filter((trial) => trial.taskId === taskId);
    if (baselineTrials.length === 0) continue;

    pairs.push({
      taskId,
      candidateMs: median(candidateTrials.map((t) => t.durationMs)),
      baselineMs: median(baselineTrials.map((t) => t.durationMs)),
      ratio: median(candidateTrials.map((t) => t.durationMs)) /
        median(baselineTrials.map((t) => t.durationMs)),
    });
  }

  return pairs;
}

export interface Claim {
  /** Median across tasks of the within-task candidate/baseline ratio. */
  speedup: number;
  /** Spread of those per-task ratios. A speedup with huge spread is not real. */
  speedupSpread: number;
  /** Stable only when the ratio spread is a small fraction of the effect. */
  stable: boolean;
  tasks: number;
  speedupRange: [number, number];
}

/**
 * A claim is `stable` when the inter-task spread is under 40% of the median
 * ratio. Looser than a p-value and far cheaper than the alternative — the
 * point is to refuse to state a number whose sign flips between tasks, not to
 * certify the effect.
 */
export const SPREAD_TOLERANCE = 0.4;

export function summariseClaim(pairs: readonly PairedRatio[]): Claim {
  const ratios = pairs.map((pair) => pair.ratio);
  const speedup = median(ratios);
  const speedupSpread = mad(ratios);
  const sorted = [...ratios].sort((a, b) => a - b);

  return {
    speedup,
    speedupSpread,
    stable: speedup > 0 && speedupSpread / speedup < SPREAD_TOLERANCE,
    tasks: pairs.length,
    speedupRange: sorted.length > 0 ? [sorted[0], sorted[sorted.length - 1]] : [0, 0],
  };
}

export interface ArmReport {
  stats: TrialStats;
  claim?: Claim;
  /** Only meaningful for the orchestrated arm. */
  derived?: {
    serialFraction: number;
    parallelism: number;
    amdahlCeiling: number;
  };
}

export function armReport(
  arm: ArmName,
  trials: readonly Trial[],
  baselineArm: readonly Trial[],
): ArmReport {
  const stats = summariseTrials(trials);

  if (arm === "single") return { stats };
  return { stats, claim: summariseClaim(pairTrials(trials, baselineArm)) };
}

/**
 * One orchestrated run, compared against the single-agent reference.
 *
 * Thin wrapper over `telemetry/analysis.compare` so the Amdahl arithmetic has
 * exactly one implementation. This exists for single-run inspection during
 * development; the published numbers should come from `summariseClaim`, which
 * sees repeated trials.
 */
export function inspectRun(report: RunReport, baseline: BaselineRun): Comparison {
  return compare(baseline, report);
}

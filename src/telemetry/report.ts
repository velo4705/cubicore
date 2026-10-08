import { addUsage, type RunReport, type TokenUsage, type WorkerRun } from "./types";
import { PhaseTimer } from "./timing";
import type { PhaseName } from "./types";

/**
 * Builds a `RunReport`. The orchestrator owns one of these per run.
 *
 * `dispatchWallMs` is derived from the dispatch phase timing rather than passed
 * in — a single source of truth means the parallelism metric cannot drift out of
 * agreement with the phase breakdown.
 */
export class RunRecorder {
  private readonly timer: PhaseTimer;
  private readonly workers: WorkerRun[] = [];
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly topology: string,
    timer = new PhaseTimer(),
  ) {
    this.timer = timer;
  }

  start(phase: PhaseName): void {
    this.timer.start(phase);
  }

  stop(phase: PhaseName): number {
    return this.timer.stop(phase);
  }

  recordWorker(worker: WorkerRun): void {
    this.workers.push(worker);
  }

  finish(usage: TokenUsage): RunReport {
    const phases = this.timer.timings();
    const dispatch = phases.find((timing) => timing.phase === "dispatch");

    return {
      startedAt: this.startedAt,
      durationMs: phases.reduce((sum, timing) => sum + timing.ms, 0),
      phases,
      workers: [...this.workers],
      dispatchWallMs: dispatch?.ms ?? 0,
      usage,
      topology: this.topology,
    };
  }

  /** Worker-only usage, which is what the X/Y claims are about. */
  static workerUsage(report: RunReport): TokenUsage {
    return report.workers.reduce((sum, worker) => addUsage(sum, worker.usage), {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
  }
}

/** One line for a CI log. Deliberately not a table. */
export function summarise(run: RunReport, comparison?: {
  speedup: number;
  tokenRatio: number;
  naiveFanoutRatio: number;
  parallelism: number;
  serialFraction: number;
  amdahlCeiling: number;
  cacheHitRate: number;
}): string {
  const head = `${run.topology}: ${run.workers.length} workers, ${(run.durationMs / 1000).toFixed(1)}s`;
  if (!comparison) return head;

  const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
  return [
    head,
    `speedup ${comparison.speedup.toFixed(2)}x`,
    `tokens ${comparison.tokenRatio.toFixed(2)}x baseline`,
    `vs naive fan-out ${pct(comparison.naiveFanoutRatio)}`,
    `parallelism ${comparison.parallelism.toFixed(1)}x`,
    `serial ${pct(comparison.serialFraction)} (ceiling ${comparison.amdahlCeiling.toFixed(1)}x)`,
    `cache ${pct(comparison.cacheHitRate)}`,
  ].join(" | ");
}
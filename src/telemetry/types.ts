/**
 * Provider-agnostic telemetry types.
 *
 * Nothing in this file may import an SDK. Porting to Claude Code means adding
 * an adapter under `adapters/`, never editing these shapes — the run report is
 * the artifact the cost claim is made from, so its schema has to outlive any
 * one host.
 */

/**
 * Token counts for one model call. Providers report different subsets —
 * opencode gives all six, Claude Code omits `reasoning`. Adapters normalise
 * missing values to 0 rather than making every field optional, because
 * `totalOf` and the cost maths are not worth an `| undefined` per field.
 */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export const EMPTY_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}

/**
 * Billable-ish volume. Cache reads are counted because they still cost, but at
 * a fraction — including them here keeps `cacheRead` visible in the report
 * instead of quietly disappearing from the totals.
 */
export function totalTokens(usage: TokenUsage): number {
  return (
    usage.input +
    usage.output +
    usage.reasoning +
    usage.cacheRead +
    usage.cacheWrite
  );
}

/** Fraction of tokens served from cache. Above ~0.5 means prefix caching works. */
export function cacheHitRate(usage: TokenUsage): number {
  const denominator = usage.input + usage.cacheRead + usage.cacheWrite;
  if (denominator === 0) return 0;
  return usage.cacheRead / denominator;
}

/** Serial phases. Parallelism happens inside `dispatch`. */
export type PhaseName = "plan" | "validate" | "dispatch" | "review" | "aggregate";

export interface PhaseTiming {
  phase: PhaseName;
  ms: number;
}

/** One dispatched worker. `ms` is its own duration, not its share of wall time. */
export interface WorkerRun {
  contractId: string;
  ms: number;
  usage: TokenUsage;
  toolCalls: number;
}

export interface RunReport {
  startedAt: string;
  durationMs: number;
  phases: PhaseTiming[];
  workers: WorkerRun[];
  /** Wall-clock span of the whole dispatch phase. Sum of workers may exceed it. */
  dispatchWallMs: number;
  usage: TokenUsage;
  topology: string;
}

/**
 * The comparative claim. `tokenRatio` is Y in the pitch; `speedup` is the N.
 * Both are meaningless without a baseline, so they are fields rather than
 * properties of a single run.
 */
export interface Comparison {
  baselineMs: number;
  baselineTokens: number;
  baselineCost: number;

  speedup: number;
  tokenRatio: number;
  costRatio: number;

  /** Mean worker cost vs the single-agent total. Lower than 1 is the win. */
  perWorkerTokenReduction: number;
  /** This run against a naive N-worker fan-out. This is Y in the pitch. */
  naiveFanoutRatio: number;
  cacheHitRate: number;

  /** workerSumMs / dispatchWallMs. ~1 means no parallelism happened. */
  parallelism: number;
  /** Share of wall time in serial phases. The Amdahl ceiling. */
  serialFraction: number;
  /** Speedup an idealised run would achieve at this serial fraction. */
  amdahlCeiling: number;
}
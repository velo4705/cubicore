import type { PhaseName, PhaseTiming } from "./types";

/**
 * Times the serial phases. Parallelism lives inside `dispatch` and is measured
 * by comparing worker durations against the dispatch span, not here.
 *
 * The clock is injectable so tests are deterministic — timing code that can
 * only be tested with `sleep` is timing code nobody tests.
 */
export class PhaseTimer {
  private readonly open = new Map<PhaseName, number>();
  private readonly done: PhaseTiming[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  start(phase: PhaseName): void {
    if (this.open.has(phase)) {
      throw new Error(`phase "${phase}" is already running`);
    }
    this.open.set(phase, this.now());
  }

  /** Returns the phase duration in ms. Throws if the phase was never started. */
  stop(phase: PhaseName): number {
    const started = this.open.get(phase);
    if (started === undefined) {
      throw new Error(`phase "${phase}" was never started`);
    }
    this.open.delete(phase);
    const ms = this.now() - started;
    this.done.push({ phase, ms });
    return ms;
  }

  /** Measures `phase` around `run`, returning its result. */
  async around<T>(phase: PhaseName, run: () => Promise<T>): Promise<T> {
    this.start(phase);
    try {
      return await run();
    } finally {
      this.stop(phase);
    }
  }

  timings(): PhaseTiming[] {
    return [...this.done];
  }

  total(): number {
    return this.done.reduce((sum, timing) => sum + timing.ms, 0);
  }

  running(): PhaseName[] {
    return [...this.open.keys()];
  }
}
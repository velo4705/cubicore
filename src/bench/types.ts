import type { TokenUsage, RunReport } from "../telemetry/types";

/**
 * One measured run of one arm on one task.
 *
 * A single run is not a measurement. Agent latency and token counts are
 * heavy-tailed — one lucky or pathological run moves the mean more than a
 * dozen typical ones. Everything in this module exists to make repeated trials
 * the unit of evidence rather than the single run.
 */

export type ArmName =
  /** One agent, whole task, no orchestration. The reference point. */
  | "single"
  /** N agents, each independently loading full context. The control. */
  | "naive-fanout"
  /** Cubicore. */
  | "orchestrated";

export interface Trial {
  taskId: string;
  arm: ArmName;
  /** Wall-clock duration. */
  durationMs: number;
  usage: TokenUsage;
  /** Populated for the orchestrated arm only. */
  report?: RunReport;
  /** Repeated runs of a hung agent must not be silently averaged in. */
  timedOut?: boolean;
}

export interface TaskSpec {
  id: string;
  prompt: string;
  /**
   * Expected fan-out width. Used to configure arm B, and to sanity-check that
   * the planner chose a comparable number of workers — a task planned into 2
   * contracts cannot be compared against an 8-way naive baseline.
   */
  expectedWorkers: number;
}

export interface TrialStats {
  n: number;
  medianMs: number;
  medianTokens: number;
  medianCost: number;
  /** Median absolute deviation — spread that a mean would hide. */
  spreadMs: number;
  minMs: number;
  maxMs: number;
  timeouts: number;
}

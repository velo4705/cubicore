import type { WorkerResult } from "../contracts/types";
import { summarise } from "../telemetry/report";
import { addUsage, EMPTY_USAGE, type RunReport, type TokenUsage } from "../telemetry/types";

/**
 * Aggregation reads artifacts, never transcripts (D7).
 *
 * The dependency rule is what enforces this: `aggregate/` may not import
 * `dispatch/` or `coordinator/`, so it is structurally unable to reach a
 * worker's conversation even by accident.
 */

export interface AggregatedArtifact {
  contractId: string;
  status: string;
  deliverable: string;
  changedFiles: string[];
  unresolved: string[];
}

export interface Aggregation {
  artifacts: AggregatedArtifact[];
  usage: TokenUsage;
  summary: string;
}

/**
 * `unresolved` lines are routed to the artifact that owns them rather than
 * flattened into one blob. A failure the worker could not resolve must stay
 * attached to the thing that failed, or the user cannot act on it.
 */
export function aggregate(
  results: WorkerResult[],
  unresolved: string[],
  report: RunReport,
): Aggregation {
  const artifacts: AggregatedArtifact[] = results.map((result) => ({
    contractId: result.contractId,
    status: result.status,
    deliverable: result.artifact?.deliverable ?? "none",
    changedFiles: result.changedFiles,
    unresolved:
      result.status === "accepted"
        ? []
        : unresolved.filter((line) => line.startsWith(`${result.contractId} —`)),
  }));

  const usage = results.reduce((sum, result) => addUsage(sum, result.usage), EMPTY_USAGE);

  return { artifacts, usage, summary: summarise(report) };
}
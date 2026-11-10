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
  /**
   * true when a blocking check failed only because it could not run on this
   * host — missing tool, empty output, network offline. Distinct from
   * "bad code". The retrospective uses it so the founder sees the real reason.
   */
  unverified: boolean;
}

/**
 * Best-effort probe of the unresolved lines for the "unverified" phrase.
 * The gate owns this wording; aggregate checks it exists before anyone else
 * relies on it for UX. If the wording changes in gate, this fallback degrades
 * to "unverified = false" — no crash, no false positives.
 */
function isUnverified(unresolved: readonly string[], contractId: string): boolean {
  return unresolved.some((line) =>
    line.startsWith(`${contractId} —`) && /could not run/i.test(line),
  );
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
  /**
   * Contracts whose gates failed.
   *
   * `WorkerResult.status` says the *session* finished -- "accepted" there
   * means nothing errored. It is not a verdict: a worker whose checks all
   * failed still finished cleanly. Reading status as the verdict produced
   * two components disagreeing about the same run, one reporting
   * "0 passed, 4 flagged" and the other listing all four as accepted.
   *
   * The gate outcome is known here, so it is passed in rather than inferred.
   */
  failedContracts: readonly string[] = [],
): Aggregation {
  const failed = new Set(failedContracts);
  const blocked = new Set(
    results
      .map((r) => r.contractId)
      .filter((id) => failed.has(id)),
  );
  const artifacts: AggregatedArtifact[] = results.map((result) => {
    const flagged = failed.has(result.contractId);
    const unverified = isUnverified(unresolved, result.contractId);
    return {
      contractId: result.contractId,
      status: flagged ? (unverified ? "blocked" : "flagged") : result.status,
      deliverable: result.artifact?.deliverable ?? "none",
      changedFiles: result.changedFiles,
      unresolved: flagged
        ? unresolved.filter((line) => line.startsWith(`${result.contractId} —`))
        : [],
      unverified,
    };
  });

  const usage = results.reduce((sum, result) => addUsage(sum, result.usage), EMPTY_USAGE);

  return { artifacts, usage, summary: summarise(report) };
}
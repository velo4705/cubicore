import type { Contract } from "../contracts/types";
import { movedAnchors } from "./anchors";

/**
 * The reviewer.
 *
 * It is **not** a quality critic. Semantic judgment was cut in v1 alongside
 * `judgment` checks, and a reviewer asking "is this good?" would reintroduce
 * exactly the untrustworthy authorship D9 removed. There is no mandate for it
 * here and no way to bound its opinions.
 *
 * What it does instead is verify bar integrity — whether a worker that already
 * failed a check reached the retry by fixing the code or by weakening the check.
 * That is mechanical, needs no judgment, and is the only place in the system
 * where a worker's incentive runs directly against the bar.
 *
 * Two questions, both answered by diffing repo state across the retry:
 *   1. Did a check's *definition* change? (`scripts.lint` edited or deleted)
 *   2. Were test files removed? (green because fewer things run)
 *
 * Both produce evidence, never an opinion. D5 survives in adapted form: a
 * finding without named evidence is dropped, so a vague "consider improving
 * this" can never become a round trip.
 */

export type ReviewCode = "check-definition-moved" | "tests-removed";

export interface ReviewFinding {
  code: ReviewCode;
  contractId: string;
  detail: string;
  /**
   * D5. The specific file, command or count that proves the finding. A finding
   * without this is dropped rather than forwarded.
   */
  evidence: string;
}

export interface ReviewInput {
  contract: Contract;
  /** Anchor values by command, captured before the revision. */
  anchorsBefore: ReadonlyMap<string, string>;
  anchorsAfter: ReadonlyMap<string, string>;
  testFilesBefore: readonly string[];
  testFilesAfter: readonly string[];
}

/**
 * Conventions the caller uses to enumerate test files. Defaults rather than a
 * rule: a repo with an unusual layout supplies its own, because a reviewer that
 * guesses at "what counts as a test" invents findings.
 */
export const DEFAULT_TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "test/**",
  "tests/**",
  "__tests__/**",
];

/**
 * Review runs on the revise round only.
 * On the first attempt the worker has no reason to touch the bar — it has not
 * failed yet, so the gates are sufficient. The retry is the only moment worth
 * spending reviewer tokens on, which roughly halves reviewer cost and points it
 * at the single place it can do work. D6 caps the retry at 1, so this is at most
 * one review per contract.
 */
export function shouldReview(attempt: number): boolean {
  return attempt > 0;
}

export function review(input: ReviewInput): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const anchor of movedAnchors(input.anchorsBefore, input.anchorsAfter)) {
    findings.push({
      code: "check-definition-moved",
      contractId: input.contract.id,
      detail: `check "${anchor.command}" changed definition during the revision`,
      evidence: `${anchor.file} ${anchor.key}: "${anchor.before}" -> "${anchor.after}"`,
    });
  }

  const removed = input.testFilesBefore.filter(
    (file) => !input.testFilesAfter.includes(file),
  );

  if (removed.length > 0) {
    findings.push({
      code: "tests-removed",
      contractId: input.contract.id,
      detail:
        `${removed.length} test file(s) disappeared during the revision, so a passing ` +
        `suite may be passing less than it was`,
      evidence: removed.slice(0, 5).join(", "),
    });
  }

  return gate(findings);
}

/**
 * D5, adapted. Every finding this module produces carries evidence by
 * construction, so the gate is structural: a future finding added without
 * evidence is dropped instead of forwarded.
 */
export function gate(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.filter((finding) => finding.evidence.trim().length > 0);
}
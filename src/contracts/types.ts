import type { TokenUsage } from "../telemetry/types";

export type Topology =
  | "fan-out"
  | "pipeline"
  | "shared-context"
  | "refuse";

export type Deliverable = "diff" | "report" | "data";

export type CheckKind =
  /** Project standing rules, derived from the repo once at setup. */
  | "baseline"
  /** Measured over changed lines. Cannot be asserted, only run. */
  | "coverage"
  /** Derived from the user's stated intent, authored by the planner. */
  | "intent"
  /** Semantic judgment. Cut in v1 — no agent-side author is trustworthy. */
  | "judgment";

/**
 * Gating weight, not defect severity.
 *
 * This replaced a blocker/major/minor scale, which could only ever take two
 * values in v1 — subjective grading is cut along with `judgment` checks. What
 * actually gates is whether a failure blocks the artifact or merely annotates
 * it.
 */
export type Gating = "blocking" | "advisory";

export interface Check {
  id: string;
  kind: CheckKind;
  /** Executable, e.g. "npm run typecheck", "npm test -- src/a". */
  command: string;
  /** What a pass means. Must be observable, not a feeling. */
  expectation: string;
  gating: Gating;
  /**
   * Whether one revision could plausibly make this pass.
   *
   * Typecheck and the test suite converge — one fix satisfies them. Coverage
   * thresholds and complexity limits do not: a worker told to hit 100% branch
   * coverage thrashes and burns budget without converging.
   *
   * Only `blocking` ∧ `convergent` failures may trigger a revise round.
   */
  convergent: boolean;
}

export interface Budget {
  tokens: number;
  toolCalls: number;
  wallMs: number;
}

export interface GraphBudget {
  nodes: number;
  edges: number;
  tokens: number;
  wallMs: number;
}

export interface Contract {
  id: string;
  objective: string;
  /** Globs this worker may read. Overlap between workers is expected and safe. */
  reads: string[];
  /** Globs this worker may write. Must be disjoint across all contracts. */
  writes: string[];
  /** Globs this worker must never touch, read or write. */
  forbidden: string[];
  deliverable: Deliverable;
  schema: Record<string, unknown>;
  doneWhen: string;
  /** Cases this contract adds on top of the project baseline. */
  checks: Check[];
  budget: Budget;
}

export interface Plan {
  topology: Topology;
  contracts: Contract[];
  graphBudget: GraphBudget;
}

/**
 * What a worker hands back. Never a transcript — the aggregator reads these and
 * nothing else, which is what keeps D7 true rather than aspirational.
 */
export interface Artifact {
  contractId: string;
  deliverable: Deliverable;
  raw: string;
}

export type WorkerStatus = "accepted" | "failed" | "budget-exhausted";

export interface WorkerResult {
  contractId: string;
  status: WorkerStatus;
  artifact?: Artifact;
  /** Files the worker actually modified, for the scope gate. */
  changedFiles: string[];
  usage: TokenUsage;
  ms: number;
  toolCalls: number;
}

export type FindingCode =
  | "empty-plan"
  | "duplicate-id"
  | "missing-objective"
  | "invalid-budget"
  | "missing-schema"
  | "missing-done-when"
  | "no-blocking-check"
  | "write-collision"
  | "writes-forbidden"
  | "budget-exceeded"
  | "invalid-check"
  | "unsupported-check-kind"
  | "baseline-dropped"
  /** Coordinator output did not parse. Distinct from `empty-plan`. */
  | "malformed-plan";

export interface Finding {
  code: FindingCode;
  contractIds: string[];
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  findings: Finding[];
}
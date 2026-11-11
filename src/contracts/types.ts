import type { TokenUsage } from "../telemetry/types";
import type { FactoryFit } from "../factory/fit";

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

export interface Step {
  id: string;
  /** Human-readable description of this step. */
  description: string;
  /** Files this step writes. Must be disjoint from other steps' writes within this contract. */
  writes: string[];
  /** Optional command to verify this step is complete. If absent, the associate self-reports. */
  check?: string;
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
  /** Ordered sub-steps within this contract. Each step can be tracked independently
   *  so an interrupted run can resume from completed steps rather than restarting
   *  the whole contract. */
  steps?: Step[];
  budget: Budget;
  /** MCP servers or tools this contract is authorised to use.
   *
   * The "workshop" model: every MCP the host has registered is available to
   * any associate, but the plan declares which ones this contract will use.
   * Empty array or absent means no MCP/tools needed beyond the base tool set.
   */
  /** Marks this contract screen-facing. Triggers the design requirement. */
  ui?: boolean;
  tools?: string[];
  /**
   * The role this contract belongs to. Exact authority, not an honorific —
   * the factory can enforce it at gate time on hosts with attributed tool
   * events; on opencode 2.1.3 it is advisory (see gateRole).
   */
  role?: Role;
}

import type { PreviewSpec } from "../plan/preview";

export interface PlanContext {
  /** What problem does this solve? One or two sentences. */
  problem: string;
  /** Who is this for? Target users or audience. */
  users: string;
  /** What can someone do with this? Concrete scenarios. */
  useCases: string[];
  /** Why this over alternatives? What makes it worth building? */
  benefits: string[];
  /** What to show live in a demo? Step-by-step flow. */
  demoFlow: string[];
  /** Where could this go next? Future directions. */
  futureWork: string[];
  /** Market opportunity — TAM, who pays, how big is the market. */
  marketOpportunity: string;
  /** Business model — how does this make money or sustain itself? */
  businessModel: string;
  /** Competitive advantage — what's hard to copy, what's the moat. */
  competitiveAdvantage: string;
  /** Go-to-market — how do you get the first 100 users? */
  goToMarket: string;
  /** Risks — what could go wrong, what are the unknowns. */
  risks: string[];
  /** Current status — idea, prototype, MVP, live, etc. */
  currentStatus: string;
  /** The ask — what do you need: team members, funding, partnerships, feedback. */
  ask: string[];
}

export type DesignAmbition = "calm" | "standard" | "bold";

/**
 * The aesthetic direction for this project. Mandatory for UI-capable plans:
 * the planner proposes 2-3 directions, the founder picks one in review, and
 * the validator rejects UI plans without one before dispatch.
 *
 * `ui` marks a contract as screen-facing. UI capability is detected two
 * ways and either triggers the requirement: an explicit `ui: true`, or a
 * writes glob that targets screen-facing files (html/css/jsx/tsx/svelte/
 * vue/astro/htm).
 */

/**
 * A factory role — not a label. A role is a capability-scoped contract: what
 * this associate may do, on what data, with what budgets, and what it hands
 * back. Agnostic of model; agnostic of agent name.
 *
 * On opencode 2.1.3, the tool and file attribution observe.ts needs is not
 * available — the host does not attribute events to sessions — so toolPolicy
 * is enforced as an advisory-only gate. On hosts with event attribution,
 * it is enforceable at run time. Either way, the role's limits live in the
 * plan on disk — reviewable before the run starts, not an honorific in the
 * agent config.
 */
export interface Role {
  /** The role's own name — e.g. "owner-of-types", "verify-only". Not a job title. */
  name: string;
  /** Capabilities this role exercises. Disjoint from sibling roles' where possible. */
  capabilities: readonly string[];
  /** Advisory on opencode 2.1.3 (no attribution); enforceable on hosts that emit attributed tool events. */
  tools?: {
    allow?: readonly string[];
    deny?: readonly string[];
  };
  /** What this role owes the integration wave, and who consumes it. */
  handoff?: {
    deliverable: string;
    audience: string;
  };
  /** Explicit exclusions — not recommendations, contractual statements. */
  exclusions?: readonly string[];
  /**
   * When the role cannot do its job: the expected transition
   * ("blocked, reasons, needs a human"), not a retry budget.
   */
  escalation?: string;
  /** Role-level budget; defaults to the containing contract's budget. */
  budget?: {
    tokens?: number;
    toolCalls?: number;
    wallMs?: number;
  };
}

export interface Design {
  /** Named direction: e.g. "editorial", "terminal", "porcelain", "industrial". */
  direction: string;
  /** Hex colors, at most 4. The accent colour is listed last. Every hex in
   *  the diff must appear in this palette — that is the gate. */
  palette: string[];
  /** Typeface family name. */
  typeface: string;
  /** Type scale ratio between 1.1 and 1.5. */
  typeScale?: number;
  /** Base spacing unit in px. */
  spacing?: number;
  /** Radii levels in use; at most two. */
  radii?: number[];
  /** One signature element the whole product hangs off. */
  signature?: string;
  /** Things explicitly not done. Ends debates up front. */
  notDoing: string[];
  /** How far from minimal the result may wander. */
  ambition: DesignAmbition;
}

export interface Plan {
  topology: Topology;
  contracts: Contract[];
  graphBudget: GraphBudget;
  /** Design direction for UI-capable projects. Absent for back-end/library work. */
  design?: Design;
  /**
   * "Planner's opinion" — the planner's short argument for what this build
   * should be in full, what is deliberately left out, and why.
   *
   * This is advice, not scope: execute does not dispatch against it,
   * it is never read by the dispatcher, and the founder strikes it for free
   * in refine. It exists so a founder who cannot spell out the details still
   * sees what an expert would include by default and why — then approves a
   * plan that is authoritatively better than their bare prompt, or strips it
   * to whatever they actually wanted.
   */
  opinion?: string;

  /**
   * Human-readable description of what this project is, for the founder.
   * Rendered at the top of CUBICORE_PLAN.md so anyone can understand
   * what is being built without reading every contract.
   */
  summary?: string;
  /**
   * Narrative context for human readers — problem, users, use cases,
   * benefits, demo flow, future work. Rendered at the top of
   * CUBICORE_CONTEXT.md so team members can present the project in person.
   * Not parsed by Execute; never affects what gets built.
   */
  context?: PlanContext;
  /**
   * How to run the result, when the result is something that runs.
   *
   * Absent for a library or a report, present for anything the founder is
   * meant to start. The absence is not a defect: some deliverables have
   * nothing to run.
   */
  preview?: PreviewSpec;
  /**
   * Planner's honest size classification of the request, chosen before the
   * first contract. Guides the plan; never a gate by itself.
   */
  scale?: "small" | "medium" | "large" | "massive";

  /**
   * The decision the factory-fit pre-dispatch assessment makes — how many
   * associates, why them, why not more. Set by plan, read by dispatch.
   */
  factoryFit?: FactoryFit;
  /**
   * The integration wave: one command that proves the *merged* tree still
   * works — `npm run build`, `tsc --noEmit`, `cargo check`, a smoke script
   * that boots the app. Absent for libraries and reports with nothing to
   * build. Contracts' checks pass individually, but the union of separately
   * green contracts can still be a broken build; this gate exists so that
   * failure is caught before hand-off, not by the founder after it.
   *
   * `timeoutMs` caps the wave; a hung build must not hang the factory.
   */
  integration?: { command: string; timeoutMs?: number };
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
  /**
   * True when the changed-file list could not be determined.
   *
   * Distinct from an empty list: "changed nothing" is a fact, and "could not
   * tell" is an absence of evidence. The scope gate must not report the
   * second as the first.
   */
  changesUnknown?: boolean;
  /** Directory the changed files live in (worktree, or project root when worktrees are disabled/degraded). */
  root?: string;
  usage: TokenUsage;
  ms: number;
  toolCalls: number;
  /**
   * Whether the host actually terminated an over-budget session. False when
   * Cubicore merely stopped waiting, which is not the same thing — a session
   * left running keeps spending.
   */
  cancelled: boolean;
}

export type FindingCode =
  | "weak-contrast-palette"
  | "missing-design"
  | "missing-ui-smoke"
  | "missing-objective"
  | "duplicate-id"
  | "duplicate-check-id"
  | "missing-schema"
  | "missing-done-when"
  | "invalid-budget"
  | "missing-baseline"
  | "baseline-dropped"
  | "unsupported-check-kind"
  | "invalid-check"
  | "missing-blocking-check"
  | "invalid-deliverable"
  | "catch-all-write-scope"
  | "no-blocking-check"
  | "unfalsifiable"
  | "vague-objective"
  | "no-write-scope"
  | "empty-plan"
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
  | "malformed-plan"
  /** The planner's declared topology disagrees with the plan's own structure. */
  | "mis-declared-topology";

export interface Finding {
  code: FindingCode;
  contractIds: string[];
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  findings: Finding[];
}
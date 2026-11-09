import type { Contract, Plan, Topology } from "../contracts/types";
import { findDependencies } from "../coordinator/topology";

/**
 * The question Cubicore answers before anything else: is this a factory job?
 *
 * A factory is the right answer to some tasks and an expensive mistake to
 * others. This is the same honesty rule the rest of the system runs on: an
 * answer can be refused, underspecified, or "too costly for what it buys" —
 * but it never pretends a team is warranted when the evidence doesn't show it.
 *
 * The assessment is mechanical: it reads the plan. It does not ask the model
 * to make a call it cannot be trusted to make, and it is cheap enough to
 * print at dispatch time.
 */

export type FactoryDecision =
  | "single-agent"
  | "small-factory"
  | "standard-factory"
  | "pipeline"
  | "single-reader";

export interface FactoryFit {
  decision: FactoryDecision;
  /** Number of associates to dispatch, and why that number. */
  workers: number;
  confidence: "high" | "medium" | "low";
  topology: Topology;
  /** Why this decision was reached. Human-readable. */
  why: string;
  /** Why not more workers. Human-readable. */
  whyNotMore: string;
  evidence: string[];
}

export interface FitInput {
  topology: Topology;
  contracts: readonly Contract[];
}

/** Deterministic factory-fit assessment for a plan. */
export function assessFactoryFit(input: FitInput): FactoryFit {
  const { topology, contracts } = input;
  const evidence: string[] = [];

  // Refuse means the planner already refused to split — that decision is
  // final and no ledger can second-guess it.
  if (topology === "refuse") {
    return {
      decision: "single-agent",
      workers: 1,
      confidence: "high",
      topology,
      why: "planner refused to split; the work is not decomposable",
      whyNotMore: "the plan itself declines a team",
      evidence: ["topology is refuse"],
    };
  }

  // One contract can never benefit from coordination.
  if (contracts.length <= 1) {
    return {
      decision: "single-agent",
      workers: 1,
      confidence: "high",
      topology,
      why: "a single contract is one coherent unit of work; a team here is pure coordination cost",
      whyNotMore: "nothing to parallelise against",
      evidence: ["contracts.length ≤ 1"],
    };
  }

  const edges = findDependencies(contracts);
  const dependencyPressure = edges.length / Math.max(1, contracts.length - 1);

  evidence.push(`${contracts.length} contracts`, `${edges.length} dependency edges`);

  // Strong coupling across almost every contract means a pipeline: one stage
  // feeds the next and parallelism buys nothing.
  if (topology === "pipeline" || dependencyPressure > 0.6) {
    return {
      decision: "pipeline",
      workers: contracts.length,
      confidence: edges.length === 0 ? "medium" : "high",
      topology: "pipeline",
      why:
        topology === "pipeline"
          ? "declared sequential — contracts run in order"
          : "dependency pressure is high; contracts feed each other more than they overlap",
      whyNotMore:
        "adding workers inside a stage conflates independent paths with shared handoffs and buys nothing",
      evidence: [...evidence, `dependency ratio ${dependencyPressure.toFixed(2)}`],
    };
  }

  // Shared-context: several contracts all read a large shared surface but
  // write disjoint outputs. A single reader amortizes the reading cost; the
  // rest consume its findings.
  const fanout = contracts.filter((c) => c.reads.length >= 3 && c.writes.length <= 2);
  if (fanout.length >= Math.ceil(contracts.length / 2)) {
    return {
      decision: "single-reader",
      workers: contracts.length,
      confidence: "medium",
      topology: "shared-context",
      why: "most contracts share the same read surface; one reader can build the context once and the rest consume it",
      whyNotMore: "the rest gain nothing by reading the same tree independently",
      evidence: [...evidence, `${fanout.length} contract(s) share heavy read scope`],
    };
  }

  // Small factory — two or three disjoint pieces of work, one wave.
  if (contracts.length <= 3) {
    return {
      decision: "small-factory",
      workers: contracts.length,
      confidence: edges.length === 0 ? "high" : "medium",
      topology: "fan-out",
      why: "a few genuinely independent slices — parallel work pays",
      whyNotMore: "any extra worker adds coordination with nothing to parallelise against",
      evidence: [...evidence, "dependencies do not gate dispatch"],
    };
  }

  // Standard factory — larger disjoint scope set.
  if (edges.length <= contracts.length) {
    return {
      decision: "standard-factory",
      workers: contracts.length,
      confidence: "medium",
      topology: "fan-out",
      why: `${contracts.length} contracts with bounded interdependency — a fan-out pays`,
      whyNotMore: "each contract is already a coherent unit; subdividing further burns tokens on coordination",
      evidence: [...evidence, `edges ${edges.length} ≤ contracts ${contracts.length}`],
    };
  }

  // Fall-through: many contracts, many edges, planner didn't refuse. Prefer
  // fewer workers by refusing to invent more parallelism than exists.
  return {
    decision: "pipeline",
    workers: contracts.length,
    confidence: "low",
    topology: "pipeline",
    why: "many contracts and edges; parallelism exists but the coupling is real enough to stage the work",
    whyNotMore: "cutting edges here would produce convoy effects and check races",
    evidence: [...evidence, "fallback — edges track contract count"],
  };
}

export function renderFit(fit: FactoryFit): string {
  return [
    `Decision: ${fit.decision} (team of ${fit.workers})`,
    `Why: ${fit.why}`,
    `Why not more: ${fit.whyNotMore}`,
    `Confidence: ${fit.confidence}`,
    ...fit.evidence.map((line) => `- ${line}`),
  ].join("\n");
}

/**
 * Synthesize a one-contract plan from an existing one.
 *
 * The planner wrote N contracts with disjoint writes. Collapsing them into
 * a single contract keeps the founder's request intact, keeps disjointness
 * (one writer), keeps the checks (union), and lets the dispatcher run one
 * worker instead of N. Only used when the factory-fit decision is
 * single-agent; otherwise the plan is used verbatim.
 */
export function synthesizeSingleAgentPlan(plan: Plan): Plan {
  if (plan.contracts.length <= 1) return plan;
  const first = plan.contracts[0]!;
  const merged = {
    id: "solo",
    objective: plan.contracts.map((c) => `[${c.id}] ${c.objective}`).join("\n"),
    reads: [...new Set(plan.contracts.flatMap((c) => c.reads))],
    writes: [...new Set(plan.contracts.flatMap((c) => c.writes))],
    forbidden: [],
    deliverable: first.deliverable,
    schema: first.schema,
    doneWhen: plan.contracts.map((c) => `[${c.id}] ${c.doneWhen}`).join("; "),
    checks: [...new Map(plan.contracts.flatMap((c) => c.checks).map((chk) => [chk.id, chk])).values()],
    steps: plan.contracts.flatMap((c) => c.steps ?? []),
    budget: {
      tokens: plan.contracts.reduce((sum, c) => sum + (c.budget?.tokens ?? 0), 0),
      toolCalls: plan.contracts.reduce((sum, c) => sum + (c.budget?.toolCalls ?? 0), 0),
      wallMs: plan.contracts.reduce((sum, c) => sum + (c.budget?.wallMs ?? 0), 0),
    },
    tools: [...new Set(plan.contracts.flatMap((c) => c.tools ?? []))],
    ui: plan.contracts.some((c) => c.ui === true),
  };
  return {
    ...plan,
    topology: "pipeline",
    contracts: [merged],
    graphBudget: {
      nodes: 1,
      edges: 0,
      tokens: plan.graphBudget.tokens,
      wallMs: plan.graphBudget.wallMs,
    },
  };
}

export type FounderFactoryChoice = "team" | "single-agent";

/**
 * The founder's answer to the factory-fit question, applied to the recorded
 * decision.
 *
 * Only two things can change what executes: no run at all, or the recorded
 * decision. Overriding to a team keeps the plan exactly as written; overriding
 * to a single agent makes execute collapse it. Anything the founder says but
 * has no bearing on those two paths is kept verbatim in `why` for the audit
 * trail.
 */
export function applyFounderFactoryChoice(
  fit: FactoryFit,
  contractCount: number,
  choice: FounderFactoryChoice,
  note?: string,
): FactoryFit {
  const reason = note?.trim();
  if (choice === "single-agent") {
    return {
      ...fit,
      decision: "single-agent",
      workers: 1,
      confidence: "low",
      why: reason ?? `founder asked for one agent instead of the assessed ${fit.decision}`,
      whyNotMore: "as the founder asked",
      evidence: [...fit.evidence, "founder override at plan time"],
    };
  }
  return {
    ...fit,
    decision: contractCount <= 3 ? "small-factory" : "standard-factory",
    workers: contractCount,
    confidence: "low",
    why: reason ?? `founder asked for the team as written instead of the assessed ${fit.decision}`,
    whyNotMore: "as the founder asked",
    evidence: [...fit.evidence, "founder override at plan time"],
  };
}

/** What the founder sees in the form and in the audit record. */
export function factoryFitOptions(fit: FactoryFit, contractCount: number): {
  recommendedValue: "team" | "single-agent";
  team: { value: "team"; label: string; description: string };
  singleAgent: { value: "single-agent"; label: string; description: string };
  description: string;
} {
  const recommendedValue = fit.decision === "single-agent" ? "single-agent" : "team";
  const teamLabel = `Team of ${contractCount}`;
  const teamDescription =
    fit.decision === "single-agent"
      ? "Run the plan as written — one associate per contract."
      : fit.why;
  const singleAgentDescription =
    fit.decision === "single-agent"
      ? fit.why
      : "Collapse the plan into one agent that does the whole thing. Fewer hands, more coordination saved.";
  const description =
    `Assessment: ${fit.decision} · ${fit.workers} associate${fit.workers === 1 ? "" : "s"} · ${fit.confidence} confidence. ` +
    `${fit.why}. ${fit.whyNotMore}.`;
  return {
    recommendedValue,
    team: { value: "team", label: teamLabel, description: teamDescription },
    singleAgent: { value: "single-agent", label: "Single agent", description: singleAgentDescription },
    description,
  };
}

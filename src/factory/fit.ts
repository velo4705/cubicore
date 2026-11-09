import type { Contract, Topology } from "../contracts/types";
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

  evidence.push(`${contracts.length} contract(s)`, `${edges.length} dependency edge(s)`);

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

import type { Contract, Plan, Topology } from "../contracts/types";
import { overlaps } from "../validate/overlap";

/**
 * Topology selection.
 *
 * The planner already declares a topology. Phase 5 does not try to out-think an
 * LLM with a classifier — it *checks* the declaration against repo structure,
 * because the planner has not read the code and a plausible-sounding
 * `fan-out` over dependent contracts produces a runtime failure that no amount
 * of re-planning fixes.
 *
 * The signal is one relation, and it is mechanical:
 *
 *   **if contract A writes a path that contract B reads, B depends on A.**
 *
 * That single fact decides fan-out vs pipeline, gives the pipeline an order for
 * free, and — via a dependency *cycle* — proves non-decomposability outright.
 * A cycle means two contracts each need the other's output, which is exactly
 * the shape that "this is not a divide-and-conquer task" describes.
 */

export interface DependencyEdge {
  producer: string;
  consumer: string;
  /** The path pattern that creates the dependency. */
  via: string;
}

/** Matches globs conservatively, in the safe direction: over-detects. */
export function findDependencies(contracts: readonly Contract[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  for (const producer of contracts) {
    for (const consumer of contracts) {
      if (producer.id === consumer.id) continue;

      for (const written of producer.writes) {
        for (const read of consumer.reads) {
          if (overlaps([written], [read])) {
            edges.push({ producer: producer.id, consumer: consumer.id, via: written });
          }
        }
      }
    }
  }

  return dedupe(edges);
}

function dedupe(edges: readonly DependencyEdge[]): DependencyEdge[] {
  const seen = new Set<string>();
  const out: DependencyEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.producer}->${edge.consumer} via ${edge.via}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

export interface Stage {
  index: number;
  /** Contracts that may run concurrently within this stage. */
  contracts: Contract[];
}

export interface Pipeline {
  stages: Stage[];
  /** Contract ids participating in a dependency cycle. */
  cycles: string[][];
}

/**
 * Groups contracts into stages. Everything in one stage is genuinely parallel;
 * a later stage may depend on anything earlier.
 *
 * Returns cycles rather than throwing, because a cycle is a *finding* the
 * planner needs to hear about, not a crash.
 */
export function stages(contracts: readonly Contract[]): Pipeline {
  const edges = findDependencies(contracts);
  const cycles = findCycles(edges);

  const blockedBy = new Map<string, Set<string>>();
  for (const contract of contracts) blockedBy.set(contract.id, new Set());
  for (const edge of edges) {
    blockedBy.get(edge.consumer)?.add(edge.producer);
  }

  // Contracts inside a cycle run together rather than deadlocking the ordering.
  const cyclic = new Set(cycles.flat());

  const remaining = new Set(contracts.map((c) => c.id));
  const ordered: Stage[] = [];

  while (remaining.size > 0) {
    const ready = contracts.filter((contract) => {
      if (!remaining.has(contract.id)) return false;
      const blockers = blockedBy.get(contract.id) ?? new Set();
      return [...blockers].every((blocker) => !remaining.has(blocker));
    });

    // Nothing unblocked: the rest are all in cycles.
    const batch = ready.length > 0 ? ready : contracts.filter((c) => remaining.has(c.id));
    if (batch.length === 0) break;

    ordered.push({
      index: ordered.length,
      contracts: batch,
    });

    for (const contract of batch) remaining.delete(contract.id);
  }

  return { stages: ordered, cycles };
}

function findCycles(edges: readonly DependencyEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.producer) ?? [];
    list.push(edge.consumer);
    adjacency.set(edge.producer, list);
  }

  const cycles: string[][] = [];
  const state = new Map<string, "open" | "closed">();
  const stack: string[] = [];

  const visit = (node: string): void => {
    const current = state.get(node);
    if (current === "closed") return;

    if (current === "open") {
      // Back edge: everything from `node` upward is mutually dependent.
      const start = stack.indexOf(node);
      if (start >= 0) cycles.push([...stack.slice(start), node]);
      return;
    }

    state.set(node, "open");
    stack.push(node);

    for (const next of adjacency.get(node) ?? []) visit(next);

    stack.pop();
    state.set(node, "closed");
  };

  for (const node of adjacency.keys()) visit(node);

  return cycles;
}

/**
 * The topology the structure implies, which is not always the one the planner
 * declared. `refuse` is never implied — a cycle yields `pipeline` with the
 * cyclic ids attached, because the planner should re-plan rather than the
 * validator silently override it.
 */
export function impliedTopology(pipeline: Pipeline): Topology {
  if (pipeline.cycles.length > 0) return "refuse";
  if (pipeline.stages.length > 1) return "pipeline";
  return "fan-out";
}

export interface TopologyCheck {
  ok: boolean;
  declared: Topology;
  implied: Topology;
  edges: DependencyEdge[];
  cycles: string[][];
  /** Human-readable reasons, one per problem found. */
  messages: string[];
}

export function checkTopology(plan: Plan): TopologyCheck {
  const pipeline = stages(plan.contracts);
  const edges = findDependencies(plan.contracts);
  const implied = impliedTopology(pipeline);
  const messages: string[] = [];

  if (plan.topology === "refuse") {
    return { ok: true, declared: "refuse", implied, edges, cycles: pipeline.cycles, messages };
  }

  if (pipeline.cycles.length > 0) {
    messages.push(
      `contracts ${pipeline.cycles
        .map((cycle) => cycle.join(" <-> "))
        .join("; ")} depend on each other, so this work is not decomposable — return topology "refuse"`,
    );
  } else if (plan.topology === "fan-out" && pipeline.stages.length > 1) {
    messages.push(
      `declared fan-out but ${pipeline.stages.length} stages are implied by write/read dependencies ` +
        `(${edges.map((e) => `${e.producer} -> ${e.consumer} via ${e.via}`).join("; ")})`,
    );
  } else if (plan.topology === "pipeline" && pipeline.stages.length <= 1) {
    messages.push(
      "declared pipeline but no contract reads another contract's writes; fan-out would be faster",
    );
  } else if (plan.topology === "shared-context" && pipeline.stages.length > 1) {
    messages.push(
      "declared shared-context but write/read dependencies imply ordered stages",
    );
  }

  return {
    ok: messages.length === 0,
    declared: plan.topology,
    implied,
    edges,
    cycles: pipeline.cycles,
    messages,
  };
}
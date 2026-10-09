import type { Contract } from "../contracts/types";

/**
 * Which model runs which worker.
 *
 * The load-bearing argument is not "cheap models are cheaper" — it is that **a
 * contract with a blocking check does not need the best available model.** The
 * check is the quality gate: any model that makes `npm test` pass produced an
 * acceptable artifact. Spending frontier tokens on routine work buys
 * reliability the test suite already provides.
 *
 * That argument is why the default worker model is the cheap one, and why the
 * single escalation is the revise round rather than the first attempt.
 */

export type ModelTier = "strong" | "cheap";

export interface ModelConfig {
  /** Used for the plan, the aggregate, and escalate-on-retry. */
  strong: string;
  /** The default worker model. */
  cheap: string;
}

export interface RouteContext {
  /** 0 on the first attempt, 1 on the one revise round. */
  attempt: number;
}

export interface RouteDecision {
  model: string;
  tier: ModelTier;
  reason: string;
}

/**
 * Order matters and is deliberate:
 *
 * 1. **Escalate on retry.** Revise cap is 1, so this is the only moment a
 *    stronger model can change the outcome. Spending strong-model tokens on the
 *    first attempt is wasted when the artifact passes; spending them on the
 *    retry is targeted at a known failure.
 * 2. **Advisory-only work is cheap.** No blocking check means nothing is
 *    verifying the artifact, so the work is low-stakes by construction.
 * 3. **Otherwise cheap.** A worker that satisfies a blocking check does not
 *    need the frontier model.
 */
export function routeModel(
  contract: Contract,
  config: ModelConfig,
  context: RouteContext = { attempt: 0 },
): RouteDecision {
  if (context.attempt > 0) {
    return {
      model: config.strong,
      tier: "strong",
      reason: "escalating on the single revise round",
    };
  }

  const blocking = contract.checks.some(
    (check) => check.gating === "blocking" && check.convergent,
  );

  if (!blocking) {
    return {
      model: config.cheap,
      tier: "cheap",
      reason: "advisory-only contract has no blocking check to satisfy",
    };
  }

  return {
    model: config.cheap,
    tier: "cheap",
    reason: "a blocking check gates this artifact, so the model need not be the frontier one",
  };
}

/**
 * The coordinator and aggregator always get the strong model. They are on the
 * serial critical path, where correctness compounds across every run, and they
 * see far fewer tokens than the workers do.
 */
export function coordinatorModel(config: ModelConfig): string {
  return config.strong;
}

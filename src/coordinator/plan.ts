import type { Check } from "../contracts/types";
import { PLANNER_PROMPT, REPLAN_PROMPT } from "../contracts/schema";
import type { Finding, Plan, Topology } from "../contracts/types";
import { validatePlan } from "../validate/plan";
import { MalformedPlan, formatFindings, parsePlan } from "./parse";

/**
 * The model's only job. Kept behind an interface so this module is testable
 * against fixtures and swappable when provider routing lands in Phase 3 —
 * `chat.params` and `experimental.provider.small_model` are the opencode hooks,
 * but the plan call should be routed to a strong model while workers get a
 * cheaper one.
 */
export interface Planner {
  complete(prompt: string): Promise<string>;
}

export type PlanOutcome =
  | { kind: "accepted"; plan: Plan; attempts: number }
  | { kind: "refused"; topology: Topology; attempts: number }
  | { kind: "fallback"; attempts: number; reason: string; findings: Finding[] };

/**
 * Plan, validate, re-plan once, then fall back to serial.
 *
 * The bound on replanning matters more than the replanning. A planner that
 * cannot converge must hand the work back to a single agent rather than keep
 * spending on plans that will be rejected for the same structural reason.
 */
export async function producePlan(
  planner: Planner,
  request: string,
  options: { baseline?: readonly Check[]; maxReplans?: number } = {},
): Promise<PlanOutcome> {
  const maxReplans = options.maxReplans ?? 1;
  const attempts = maxReplans + 1;

  let prompt = `${PLANNER_PROMPT}\n\nUser request:\n${request}`;
  let lastFindings: Finding[] = [];

  for (let attempt = 0; attempt < attempts; attempt++) {
    const raw = await planner.complete(prompt);

    let plan: Plan;
    try {
      plan = parsePlan(raw);
    } catch (error) {
      if (!(error instanceof MalformedPlan)) throw error;
      lastFindings = [
        {
          code: "malformed-plan",
          contractIds: [],
          message: `coordinator output was malformed: ${error.problems.join("; ")}`,
        },
      ];
      prompt = REPLAN_PROMPT.replace("{findings}", formatFindings(lastFindings));
      continue;
    }

    if (plan.topology === "refuse") {
      return { kind: "refused", topology: "refuse", attempts: attempt + 1 };
    }

    const validation = validatePlan(plan, options.baseline);
    if (validation.ok) {
      return { kind: "accepted", plan, attempts: attempt + 1 };
    }

    lastFindings = validation.findings;
    prompt = REPLAN_PROMPT.replace("{findings}", formatFindings(lastFindings));
  }

  const malformedOnly =
    lastFindings.length > 0 &&
    lastFindings.every((finding) => finding.code === "malformed-plan");

  return {
    kind: "fallback",
    attempts,
    reason: malformedOnly
      ? "coordinator produced no usable plan"
      : "plan stayed invalid after one re-plan",
    findings: lastFindings,
  };
}
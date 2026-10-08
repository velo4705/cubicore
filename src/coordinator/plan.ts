import type { Check } from "../contracts/types";
import { PLANNER_PROMPT, REPLAN_PROMPT } from "../contracts/schema";
import type { Finding, Plan, Topology } from "../contracts/types";
import { validatePlan } from "../validate/plan";
import { checkTopology } from "./topology";
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

/** Disagreements between the planner and what the plan structure implies. */
export function topologyFindings(plan: Plan): Finding[] {
  const check = checkTopology(plan);
  return check.messages.map((message) => ({
    code: "mis-declared-topology" as const,
    contractIds: check.edges.map((edge) => edge.consumer),
    message,
  }));
}

/**
 * Plan, validate, re-plan once, then fall back to serial.
 *
 * The bound on replanning matters more than the replanning. A planner that
 * cannot converge must hand the work back to a single agent rather than keep
 * spending on plans that will be rejected for the same structural reason.
 */
export interface PlanTrace {
  (event: string, detail?: Record<string, unknown>): void;
}

export async function producePlan(
  planner: Planner,
  request: string,
  options: {
    baseline?: readonly Check[];
    maxReplans?: number;
    trace?: PlanTrace;
  } = {},
): Promise<PlanOutcome> {
  const maxReplans = options.maxReplans ?? 1;
  const attempts = maxReplans + 1;

  let prompt = `${PLANNER_PROMPT}\n\nUser request:\n${request}`;
  let lastFindings: Finding[] = [];
  const trace: PlanTrace = options.trace ?? (() => {});

  for (let attempt = 0; attempt < attempts; attempt++) {
    trace("attempt.start", { attempt: attempt + 1, promptChars: prompt.length });
    const startedAt = Date.now();
    const raw = await planner.complete(prompt);
    trace("attempt.prompted", { attempt: attempt + 1, ms: Date.now() - startedAt, rawChars: raw.length });

    let plan: Plan;
    try {
      plan = parsePlan(raw);
      trace("attempt.parsed", { attempt: attempt + 1, topology: plan.topology, contracts: plan.contracts.length });
    } catch (error) {
      if (!(error instanceof MalformedPlan)) throw error;
      trace("attempt.malformed", { attempt: attempt + 1, problems: error.problems.length });
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
      // Structural validation passing is necessary but not sufficient. A plan
      // can be well-formed and still claim a topology its own structure
      // contradicts — which is exactly what the planner cannot know, having not
      // read the code it declared write scopes for.
      const topologyProblems = topologyFindings(plan);
      trace("attempt.validated", { attempt: attempt + 1, topologyProblems: topologyProblems.length });
      if (topologyProblems.length === 0) {
        return { kind: "accepted", plan, attempts: attempt + 1 };
      }
      lastFindings = topologyProblems;
    } else {
      lastFindings = validation.findings;
      trace("attempt.invalid", { attempt: attempt + 1, findings: validation.findings.map((f) => f.code) });
    }
    prompt = REPLAN_PROMPT.replace("{findings}", formatFindings(lastFindings));
  }

  trace("done.fallback");

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
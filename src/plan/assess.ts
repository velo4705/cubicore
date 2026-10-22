import { validatePlan } from "../validate/plan";
import { checkTopology } from "../coordinator/topology";
import { parsePlan, MalformedPlan } from "../coordinator/parse";
import type { Plan } from "../contracts/types";

/**
 * Deciding whether a request can be planned yet.
 *
 * "Build me a multi-million dollar SaaS" is a goal, not a task. Handed to the
 * planner it produces contracts with vague write scopes — `src/**`, or worse —
 * which either collide on overlap or pass validation while being meaningless.
 * The failure is quiet: four associates rewrite everything and every gate
 * passes, because nothing was falsifiable.
 *
 * So a plan is checked for whether it is *specific enough to be falsifiable*
 * before it is dispatched. A contract whose write scope covers everything, or
 * which cannot be described by a command that could fail, is not yet a
 * contract.
 */

export interface Planability {
  plannable: boolean;
  /** Machine-readable reasons, for the planner to act on. */
  blockers: { code: string; message: string }[];
  /** Questions only the founder can answer. Asked once, answered once. */
  questions: string[];
}

/** Glob that claims everything. */
const CATCH_ALL = /^\**$|^\/\*\*?$|^\.\/\*\*?$|^[\w./-]*\*+$/;

export function assessPlan(plan: Plan): Planability {
  const blockers: Planability["blockers"] = [];

  if (plan.topology === "refuse") {
    return { plannable: false, blockers: [{ code: "refuse", message: "plan refuses to split" }], questions: [] };
  }

  if (plan.contracts.length === 0) {
    return {
      plannable: false,
      blockers: [{ code: "empty-plan", message: "no contracts" }],
      questions: ["What specifically should be built first?"],
    };
  }

  for (const contract of plan.contracts) {
    const id = contract.id;

    // A contract that writes everything cannot own a disjoint scope, and
    // disjointness is the only thing preventing two associates from colliding.
    const catchAll = contract.writes.filter((w) => CATCH_ALL.test(w.trim()));
    if (contract.writes.length === 0) {
      blockers.push({
        code: "no-write-scope",
        message: `contract "${id}" declares no writes, so there is nothing to verify`,
      });
    }
    if (catchAll.length > 0) {
      blockers.push({
        code: "catch-all-write-scope",
        message: `contract "${id}" writes ${catchAll.join(", ")}, which claims the whole tree. ` +
          `Associates cannot own disjoint scopes that overlap entirely.`,
      });
    }

    // An objective that restates the request rather than describing an outcome
    // gives the associate nothing to aim at.
    if (contract.objective.trim().length < 15) {
      blockers.push({
        code: "vague-objective",
        message: `contract "${id}" has an objective too short to act on: "${contract.objective}"`,
      });
    }

    // A diff deliverable with no command that can fail is unfalsifiable.
    if (contract.deliverable === "diff" && contract.checks.length === 0) {
      blockers.push({
        code: "unfalsifiable",
        message: `contract "${id}" produces a diff but declares no check, so nothing can fail`,
      });
    }

    // A check that greps proves a name exists, not that the code works. Seen
    // twice in real runs: every defect passed a grep check.
    //
    // Only when the greps are the whole gate, though. A contract with a real
    // test and a grep alongside it is fine -- the grep is a cheap sanity
    // check, not the verdict. And outside code, grepping a document for a
    // required section is a perfectly good way to fail.
    const blocking = contract.checks.filter((c) => c.gating === "blocking");
    const greps = blocking.filter((c) => /^\s*grep\b/.test(c.command.trim()));
    if (blocking.length > 0 && greps.length === blocking.length && contract.deliverable === "diff") {
      blockers.push({
        code: "grep-only-check",
        message:
          `contract "${id}" gates on grep alone, which proves a name exists rather than that ` +
          `the behaviour is correct. Use a command that executes the code and can fail.`,
      });
    }
  }

  // Structural problems are reported by the validator; do not duplicate them
  // here, they are not about specificity.
  const validation = validatePlan(plan, []);
  const topology = checkTopology(plan);

  return {
    plannable: blockers.length === 0 && validation.ok && topology.ok,
    blockers: [
      ...blockers,
      ...validation.findings.map((f) => ({ code: f.code, message: f.message })),
      ...(topology.cycles.length > 0
        ? [{ code: "dependency-cycle", message: "contracts need each other" }]
        : !topology.ok
          ? [{ code: "mis-declared-topology", message: `declared ${topology.declared}, implies ${topology.implied}` }]
          : []),
    ],
    questions: blockers.length > 0 ? questionsFor(blockers) : [],
  };
}

/**
 * The smallest set of questions that unblocks the plan.
 *
 * Asked once. An associate that guesses wrong surfaces the mistake later as a
 * gate failure, having already paid for the tokens, so a question here is
 * cheaper than a wrong worker.
 */
function questionsFor(blockers: Planability["blockers"]): string[] {
  const questions = new Set<string>();
  const codes = new Set(blockers.map((b) => b.code));

  if (codes.has("catch-all-write-scope") || codes.has("no-write-scope")) {
    questions.add(
      "Which specific files or modules should the first version touch? Name them, or " +
        "say \"use a conventional layout\" and I will -- a scope of 'everything' cannot " +
        "be split safely.",
    );
  }
  if (codes.has("vague-objective")) {
    questions.add("What does done look like for each piece of work? One concrete outcome per contract.");
  }
  if (codes.has("unfalsifiable")) {
    questions.add("What command should prove each piece of work is correct? It must be able to fail.");
  }
  if (codes.has("grep-only-check")) {
    questions.add(
      "The checks only grep for names, which proves a name exists rather than that " +
        "the code works. What command executes the code and proves it behaves? If you " +
        "cannot tell, use the project's own typecheck plus one assertion per behaviour.",
    );
  }
  if (codes.has("empty-plan")) {
    questions.add("What is the first thing worth building? Not the product — the first shippable slice.");
  }

  return [...questions];
}

/** One-line human summary of why a request cannot be planned yet. */
export function explain(assessment: Planability): string {
  if (assessment.plannable) return "Plan is specific enough to dispatch.";
  return [
    "This is not yet plannable — it is a goal, not a set of contracts.",
    "",
    ...assessment.blockers.map((b) => `- [${b.code}] ${b.message}`),
    ...(assessment.questions.length
      ? [
          "",
          "Answer these, or default them and say what you defaulted:",
          "",
          ...assessment.questions.map((q, i) => `${i + 1}. ${q}`),
        ]
      : []),
  ].join("\n");
}

/** Convenience for callers holding a raw plan string. */
export function assessRaw(raw: string): { ok: true; assessment: Planability } | { ok: false; reason: string } {
  let parsed: Plan;
  try {
    parsed = parsePlan(raw) as Plan;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof MalformedPlan
        ? error.problems.join("; ")
        : String(error),
    };
  }
  return { ok: true, assessment: assessPlan(parsed) };
}
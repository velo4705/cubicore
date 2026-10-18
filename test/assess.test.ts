import { describe, expect, it } from "bun:test";

import { assessRaw, assessPlan } from "../src/plan/assess";
import { parsePlan } from "../src/coordinator/parse";
import type { Plan } from "../src/contracts/types";

/**
 * "Build me a multi-million dollar SaaS" produces a syntactically valid plan
 * whose write scopes claim the whole tree. Every structural check passes and
 * four associates collide, so specificity is checked before validity.
 */

const contract = (over: Record<string, unknown> = {}) => ({
  id: "a",
  objective: "Add input validation to the parser module",
  reads: [],
  writes: ["src/parser.ts"],
  forbidden: [],
  deliverable: "diff",
  schema: { type: "object" },
  doneWhen: "invalid input throws",
  checks: [
    {
      id: "k",
      kind: "intent",
      command: "bunx --bun tsx -e \"import {parse} from './src/parser.ts'; assert.throws(()=>parse('('))\"",
      expectation: "throws on malformed input",
      gating: "blocking",
      convergent: true,
    },
  ],
  budget: { tokens: 30_000, toolCalls: 60, wallMs: 120_000 },
  ...over,
});

const planOf = (contracts: unknown[]): Plan =>
  parsePlan(
    JSON.stringify({
      topology: "fan-out",
      contracts,
      graphBudget: { nodes: 4, edges: 1, tokens: 120_000, wallMs: 480_000 },
    }),
  ) as Plan;

const codes = (assessment: { blockers: { code: string }[] }) => assessment.blockers.map((b) => b.code);

describe("plan specificity", () => {
  it("accepts a plan whose scopes are concrete and checkable", () => {
    const a = assessPlan(planOf([contract()]));
    expect(a.plannable).toBe(true);
    expect(a.questions).toHaveLength(0);
  });

  it("rejects a write scope that claims the whole tree", () => {
    const a = assessPlan(planOf([contract({ writes: ["src/**"] })]));
    expect(a.plannable).toBe(false);
    expect(codes(a)).toContain("catch-all-write-scope");
    expect(a.questions.join(" ")).toContain("Which specific files");
  });

  it("rejects a bare glob", () => {
    expect(codes(assessPlan(planOf([contract({ writes: ["**"] })])))).toContain("catch-all-write-scope");
  });

  it("rejects a diff with nothing that can fail", () => {
    expect(codes(assessPlan(planOf([contract({ checks: [] })])))).toContain("unfalsifiable");
  });

  it("rejects a gate that only greps", () => {
    // Seen twice in real runs: every defect passed a grep check.
    const greppy = [
      contract({ id: "a" }),
      contract({ id: "b", checks: [{ id: "g", kind: "intent", command: "grep -q validate src/a.ts", expectation: "e", gating: "blocking", convergent: true }] }),
    ];
    expect(codes(assessPlan(planOf(greppy)))).toContain("grep-only-check");
  });

  it("rejects an objective too short to act on", () => {
    expect(codes(assessPlan(planOf([contract({ objective: "fix" })])))).toContain("vague-objective");
  });

  it("treats a refusal as not plannable rather than an error", () => {
    const refused = parsePlan(
      JSON.stringify({ topology: "refuse", contracts: [], graphBudget: { nodes: 1, edges: 1, tokens: 1, wallMs: 1 } }),
    ) as Plan;
    expect(assessPlan(refused).plannable).toBe(false);
  });

  it("reports the surface reason for malformed JSON", () => {
    expect(assessRaw("{ not json").ok).toBe(false);
  });

  it("asks once and only what blocks planning", () => {
    const a = assessPlan(planOf([contract({ writes: ["src/**"], objective: "x" })]));
    const unique = new Set(a.questions);
    expect(unique.size).toBe(a.questions.length);
    expect(a.questions.length).toBeGreaterThan(0);
    expect(a.questions.length).toBeLessThanOrEqual(4);
  });
});

import { describe, expect, test } from "bun:test";
import { parsePlan } from "../../src/coordinator/parse";
import {
  applyFounderFactoryChoice,
  assessFactoryFit,
  factoryFitOptions,
  synthesizeSingleAgentPlan,
} from "../../src/factory/fit";
import type { Plan } from "../../src/contracts/types";
import type { FactoryFit } from "../../src/factory/fit";

const planJson = (fit?: unknown): string =>
  JSON.stringify({
    topology: "fan-out",
    summary: "round-trip check",
    contracts: [
      {
        id: "w0",
        objective: "build module 0 with enough specificity to be actionable",
        reads: [],
        writes: ["src/0.ts"],
        forbidden: [],
        deliverable: "diff",
        schema: { type: "object" },
        doneWhen: "check passes",
        checks: [
          { id: "t", kind: "intent", command: "true", expectation: "exit 0", gating: "blocking", convergent: true },
        ],
        budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
      },
      {
        id: "w1",
        objective: "build module 1 with enough specificity to be actionable",
        reads: [],
        writes: ["src/1.ts"],
        forbidden: [],
        deliverable: "diff",
        schema: { type: "object" },
        doneWhen: "check passes",
        checks: [
          { id: "t", kind: "intent", command: "true", expectation: "exit 0", gating: "blocking", convergent: true },
        ],
        budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
      },
    ],
    graphBudget: { nodes: 3, edges: 0, tokens: 4000, wallMs: 60000 },
    ...(fit === undefined ? {} : { factoryFit: fit }),
  });

const fit: FactoryFit = {
  decision: "standard-factory",
  workers: 2,
  confidence: "medium",
  topology: "fan-out",
  why: "2 contracts with bounded interdependency — a fan-out pays",
  whyNotMore: "each contract is already a coherent unit",
  evidence: ["2 contracts", "0 dependency edges"],
};

describe("parsePlan round-trips the factory-fit decision", () => {
  test("a plan carrying factoryFit parses and keeps it", () => {
    const parsed = parsePlan(planJson(fit)) as Plan;
    expect(parsed.factoryFit).toEqual(fit);
  });

  test("a plan without factoryFit still parses", () => {
    const parsed = parsePlan(planJson()) as Plan;
    expect(parsed.factoryFit).toBeUndefined();
  });

  test("an invalid factoryFit is rejected, not silently dropped", () => {
    expect(() => parsePlan(planJson({ ...fit, decision: "behemoth" }))).toThrow();
  });

  test("the synthesized single-agent plan parses cleanly with the decision intact", () => {
    const parsed = parsePlan(planJson(fit)) as Plan;
    const single = synthesizeSingleAgentPlan(parsed);
    const reparsed = parsePlan(JSON.stringify(single)) as Plan;
    expect(reparsed.factoryFit?.decision).toBe("standard-factory");
    expect(reparsed.contracts).toHaveLength(1);
  });
});

describe("applyFounderFactoryChoice — the founder's answer is recorded, not a suggestion", () => {
  const judged = assessFactoryFit(parsePlan(planJson(fit)) as unknown as {
    topology: Plan["topology"];
    contracts: Plan["contracts"];
  });

  test("single-agent collapses regardless of the assessment", () => {
    const next = applyFounderFactoryChoice(judged, 2, "single-agent", "founder said keep it simple");
    expect(next.decision).toBe("single-agent");
    expect(next.workers).toBe(1);
    expect(next.why).toBe("founder said keep it simple");
    expect(next.whyNotMore).toBe("as the founder asked");
    expect(next.evidence.join(" ")).toContain("founder override at plan time");
  });

  test("team override keeps the plan as written", () => {
    const single = applyFounderFactoryChoice(judged, 2, "team");
    expect(single.decision).toBe("small-factory");
    expect(single.workers).toBe(2);
    expect(single.evidence).toContain("founder override at plan time");
  });

  test("larger teams override to standard-factory", () => {
    const bigger = applyFounderFactoryChoice(judged, 7, "team");
    expect(bigger.decision).toBe("standard-factory");
    expect(bigger.workers).toBe(7);
  });
});

describe("factoryFitOptions — the founder picks between two honest answers", () => {
  test("a team recommendation offers the team as recommended", () => {
    const options = factoryFitOptions(fit as never, 2);
    expect(options.recommendedValue).toBe("team");
    expect(options.team.label).toBe("Team of 2");
    expect(options.description).toContain("standard-factory");
  });

  test("a single-agent recommendation offers one agent as recommended", () => {
    const solo = { ...fit, decision: "single-agent" as const, workers: 1 };
    const options = factoryFitOptions(solo, 9);
    expect(options.recommendedValue).toBe("single-agent");
    expect(options.singleAgent.label).toBe("Single agent");
    expect(options.team.label).toBe("Team of 9");
  });
});

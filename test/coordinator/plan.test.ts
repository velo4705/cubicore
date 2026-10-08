import { describe, expect, test } from "bun:test";
import { producePlan, type Planner } from "../../src/coordinator/plan";
import type { Plan } from "../../src/contracts/types";
import { validatePlan } from "../../src/validate/plan";

const GOOD = {
  topology: "fan-out",
  contracts: [
    {
      id: "w1",
      objective: "Build the parser",
      reads: ["src/config.ts"],
      writes: ["src/parser.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "npm test -- parser passes",
      checks: [
        { id: "u", kind: "intent", command: "npm test -- parser", expectation: "exit 0", gating: "blocking", convergent: true },
      ],
      budget: { tokens: 20000, toolCalls: 40, wallMs: 300000 },
    },
  ],
  graphBudget: { nodes: 8, edges: 16, tokens: 500000, wallMs: 1200000 },
};

/** Collides on writes with GOOD. Structurally valid, semantically rejected. */
const COLLIDING = {
  ...GOOD,
  contracts: [GOOD.contracts[0], { ...GOOD.contracts[0], id: "w2", writes: ["src/parser.ts"] }],
  graphBudget: { nodes: 8, edges: 16, tokens: 500000, wallMs: 1200000 },
};

const REFUSAL = { ...GOOD, topology: "refuse", contracts: [] };

function scriptedPlanner(...responses: string[]): Planner & { calls: number } {
  let index = 0;
  return {
    get calls() {
      return index;
    },
    async complete() {
      const response = responses[Math.min(index, responses.length - 1)];
      index++;
      return response;
    },
  };
}

describe("producePlan", () => {
  test("accepts a valid plan on the first attempt", async () => {
    const planner = scriptedPlanner(JSON.stringify(GOOD));
    const outcome = await producePlan(planner, "add a parser");
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.plan.contracts).toHaveLength(1);
  });

  test("treats refusal as a success, not a failure", async () => {
    const outcome = await producePlan(scriptedPlanner(JSON.stringify(REFUSAL)), "rename core");
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.topology).toBe("refuse");
  });

  test("re-plans once when the first plan collides", async () => {
    const planner = scriptedPlanner(JSON.stringify(COLLIDING), JSON.stringify(GOOD));
    const outcome = await producePlan(planner, "add a parser");
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.attempts).toBe(2);
    expect(planner.calls).toBe(2);
  });

  test("the re-plan prompt carries the findings, so the retry can act on them", async () => {
    const prompts: string[] = [];
    const planner: Planner = {
      async complete(prompt) {
        prompts.push(prompt);
        return prompts.length === 1 ? JSON.stringify(COLLIDING) : JSON.stringify(GOOD);
      },
    };
    await producePlan(planner, "add a parser");
    expect(prompts[1]).toContain("write-collision");
    expect(prompts[1]).toContain("src/parser.ts");
  });

  test("falls back to serial when the collision persists", async () => {
    const outcome = await producePlan(scriptedPlanner(JSON.stringify(COLLIDING)), "x");
    expect(outcome.kind).toBe("fallback");
    if (outcome.kind !== "fallback") return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.findings.some((f) => f.code === "write-collision")).toBe(true);
  });

  test("re-plans after malformed output rather than trusting it", async () => {
    const planner = scriptedPlanner("here is my plan, in prose", JSON.stringify(GOOD));
    const outcome = await producePlan(planner, "add a parser");
    expect(outcome.kind).toBe("accepted");
    expect(planner.calls).toBe(2);
  });

  test("falls back when output is malformed every time", async () => {
    const outcome = await producePlan(scriptedPlanner("nope"), "x");
    expect(outcome.kind).toBe("fallback");
    if (outcome.kind !== "fallback") return;
    expect(outcome.reason).toContain("no usable plan");
    expect(outcome.findings.map((f) => f.code)).toEqual(["malformed-plan"]);
  });

  test("does not label malformed output as an empty plan", async () => {
    const outcome = await producePlan(scriptedPlanner("nope"), "x");
    if (outcome.kind !== "fallback") throw new Error("expected fallback");
    expect(outcome.findings.map((f) => f.code)).not.toContain("empty-plan");
  });

  test("never exceeds the re-plan cap", async () => {
    const planner = scriptedPlanner(JSON.stringify(COLLIDING));
    const outcome = await producePlan(planner, "x", { maxReplans: 1 });
    expect(outcome.kind).toBe("fallback");
    expect(planner.calls).toBe(2);
  });

  test("honours a zero re-plan budget", async () => {
    const planner = scriptedPlanner(JSON.stringify(COLLIDING));
    const outcome = await producePlan(planner, "x", { maxReplans: 0 });
    expect(outcome.kind).toBe("fallback");
    expect(planner.calls).toBe(1);
  });

  test("passes baseline checks into validation", async () => {
    const baseline = [
      { id: "t", kind: "baseline" as const, command: "npm run typecheck", expectation: "exit 0", gating: "blocking" as const, convergent: true },
    ];
    const planner = scriptedPlanner(JSON.stringify(GOOD));
    const outcome = await producePlan(planner, "add a parser", { baseline });
    expect(outcome.kind).toBe("accepted");
  });

  test("never executes an invalid plan, whatever the planner insists on", async () => {
    const planner = scriptedPlanner(JSON.stringify(COLLIDING));
    const outcome = await producePlan(planner, "x");
    if (outcome.kind === "accepted") {
      expect(validatePlan(outcome.plan).ok).toBe(true);
    } else {
      expect(outcome.kind).toBe("fallback");
    }
  });

  test("propagates an unexpected planner error instead of swallowing it", async () => {
    const planner: Planner = {
      async complete() {
        throw new Error("provider timeout");
      },
    };
    await expect(producePlan(planner, "x")).rejects.toThrow("provider timeout");
  });
});
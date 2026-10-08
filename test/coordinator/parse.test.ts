import { describe, expect, test } from "bun:test";
import { MalformedPlan, formatFindings, parsePlan } from "../../src/coordinator/parse";
import { planSchema } from "../../src/contracts/schema";

const VALID = {
  topology: "fan-out",
  contracts: [
    {
      id: "w1",
      objective: "Add a parser for the config file",
      reads: ["src/config.ts"],
      writes: ["src/parser.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "npm test -- parser passes",
      checks: [
        {
          id: "unit",
          kind: "intent",
          command: "npm test -- parser",
          expectation: "exit code 0",
          gating: "blocking",
          convergent: true,
        },
      ],
      budget: { tokens: 20000, toolCalls: 40, wallMs: 300000 },
    },
  ],
  graphBudget: { nodes: 8, edges: 16, tokens: 500000, wallMs: 1200000 },
};

describe("parsePlan", () => {
  test("accepts a well-formed plan", () => {
    const plan = parsePlan(JSON.stringify(VALID));
    expect(plan.topology).toBe("fan-out");
    expect(plan.contracts).toHaveLength(1);
    expect(plan.contracts[0].checks[0].gating).toBe("blocking");
  });

  test("accepts a refusal with no contracts", () => {
    const plan = parsePlan(
      JSON.stringify({ ...VALID, topology: "refuse", contracts: [] }),
    );
    expect(plan.topology).toBe("refuse");
    expect(plan.contracts).toHaveLength(0);
  });

  test("rejects non-JSON", () => {
    expect(() => parsePlan("I think we should split it into three parts")).toThrow(
      MalformedPlan,
    );
  });

  test("rejects JSON wrapped in a code fence", () => {
    const fenced = "```json\n" + JSON.stringify(VALID) + "\n```";
    expect(() => parsePlan(fenced)).toThrow(MalformedPlan);
  });

  test("rejects an unknown topology", () => {
    expect(() => parsePlan(JSON.stringify({ ...VALID, topology: "swarm" }))).toThrow(
      MalformedPlan,
    );
  });

  test("rejects unknown contract fields", () => {
    const smuggled = {
      ...VALID,
      contracts: [{ ...VALID.contracts[0], canWriteAnything: true }],
    };
    const error = catchMalformed(() => parsePlan(JSON.stringify(smuggled)));
    expect(error.problems.join(" ")).toContain("canWriteAnything");
  });

  test("rejects an unknown check kind", () => {
    const bad = {
      ...VALID,
      contracts: [
        {
          ...VALID.contracts[0],
          checks: [{ ...VALID.contracts[0].checks[0], kind: "vibes" }],
        },
      ],
    };
    const error = catchMalformed(() => parsePlan(JSON.stringify(bad)));
    expect(error.problems.join(" ")).toContain("vibes");
  });

  test("rejects a non-boolean convergent flag", () => {
    const bad = {
      ...VALID,
      contracts: [
        { ...VALID.contracts[0], checks: [{ ...VALID.contracts[0].checks[0], convergent: "yes" }] },
      ],
    };
    expect(() => parsePlan(JSON.stringify(bad))).toThrow(MalformedPlan);
  });

  test("rejects a zero budget, which validation would catch anyway", () => {
    const bad = {
      ...VALID,
      contracts: [{ ...VALID.contracts[0], budget: { tokens: 0, toolCalls: 40, wallMs: 100 } }],
    };
    expect(() => parsePlan(JSON.stringify(bad))).toThrow(MalformedPlan);
  });

  test("rejects a graph budget missing its token ceiling", () => {
    const bad = { ...VALID, graphBudget: { nodes: 8, edges: 16, wallMs: 100 } };
    const error = catchMalformed(() => parsePlan(JSON.stringify(bad)));
    expect(error.problems.join(" ")).toContain("graphBudget.tokens");
  });

  test("reports every problem, not just the first", () => {
    const bad = {
      topology: "swarm",
      contracts: [{ id: "w1", objective: "", deliverable: "diff" }],
      graphBudget: {},
    };
    const error = catchMalformed(() => parsePlan(JSON.stringify(bad)));
    expect(error.problems.length).toBeGreaterThan(2);
  });
});

describe("the emitted schema matches the parser", () => {
  test("the fixture validates against every required property in the schema", () => {
    const contractProps = Object.keys(
      (planSchema.properties.contracts as { items: { properties: object } }).items.properties,
    );
    expect(contractProps.sort()).toEqual(Object.keys(VALID.contracts[0]).sort());
  });

  test("the check enum in the schema matches what the planner prompt tells it", () => {
    const checkEnum = (
      planSchema.properties.contracts as {
        items: { properties: { checks: { items: { properties: { kind: { enum: readonly string[] } } } } } };
      }
    ).items.properties.checks.items.properties.kind.enum;
    expect(checkEnum).toEqual(["baseline", "coverage", "intent", "judgment"]);
  });
});

function catchMalformed(fn: () => unknown): MalformedPlan {
  try {
    fn();
  } catch (error) {
    if (error instanceof MalformedPlan) return error;
    throw error;
  }
  throw new Error("expected MalformedPlan");
}

describe("formatFindings", () => {
  test("renders findings for the re-plan prompt", () => {
    const text = formatFindings([
      { code: "write-collision", contractIds: ["w1", "w2"], message: "both write src/a.ts" },
    ]);
    expect(text).toBe("- [write-collision] both write src/a.ts");
  });
});
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
      tools: [],
      steps: [
        {
          id: "step-1",
          description: "Write the parser module",
          writes: ["src/parser.ts"],
        },
        {
          id: "step-2",
          description: "Write parser tests",
          writes: ["src/parser.test.ts"],
          check: "npm test -- parser",
        },
      ],
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
    // `ui` is optional by design — a non-UI contract omits it — so the schema
    // is a strict subset-breathing superset for contracts: every fixture key
    // must appear in the schema, and the schema may grow optional keys on top.
    const contractProps = Object.keys(
      (planSchema.properties.contracts as { items: { properties: object } }).items.properties,
    );
    expect(contractProps).toEqual(expect.arrayContaining(Object.keys(VALID.contracts[0])));
  });

  test("a plan carrying an opinion parses cleanly", () => {
    const withOpinion = parsePlan(JSON.stringify({ ...VALID, opinion: "one tight paragraph" }));
    expect(withOpinion.opinion).toBe("one tight paragraph");
  });

  test("an oversized opinion is rejected", () => {
    const bad = { ...VALID, opinion: "x".repeat(600) };
    try {
      parsePlan(JSON.stringify(bad));
      expect.unreachable("expected oversized opinion to throw");
    } catch (error) {
      if (!(error instanceof MalformedPlan)) throw error;
      expect(error.problems.join(" ")).toMatch(/opinion/i);
    }
  });

  test("the plan's top-level keys are the same in the schema and the parser", () => {
    // adding `preview` to the schema did not have to be added to the parser
    // either. Every plan carrying a preview block was rejected as "plan has
    // unknown field preview", and the planner had to discover that by trying.
    const schemaKeys = Object.keys(planSchema.properties).sort();
    const parserKeys = ["contracts", "opinion", "context", "design", "graphBudget", "summary", "topology", "preview", "integration"].sort();
    expect(schemaKeys).toEqual(parserKeys);

    // And the parser must accept a plan carrying every key the schema offers.
    const withPreview = parsePlan(
      JSON.stringify({
        ...VALID,
        preview: { command: "npm start", url: "http://127.0.0.1:3000/health" },
      }),
    );
    expect(withPreview.preview?.command).toBe("npm start");
  });

  test("the parser reads a UI contract's design block", () => {
    const withDesign = parsePlan(
      JSON.stringify({
        ...VALID,
        contracts: [{ ...VALID.contracts[0], ui: true }],
        design: {
          direction: "editorial",
          palette: ["#1a1a1a", "#f5f5f0", "#c8963e"],
          typeface: "Fraunces",
          notDoing: ["no second typeface", "no gradient-on-gradient"],
          ambition: "standard",
        },
      }),
    );
    expect(withDesign.design?.direction).toBe("editorial");
    expect(withDesign.design?.palette).toEqual(["#1a1a1a", "#f5f5f0", "#c8963e"]);
    expect(withDesign.contracts[0]?.ui).toBe(true);
  });

  test("the parser rejects a design block with a bad hex colour", () => {
    const error = catchMalformed(() =>
      parsePlan(
        JSON.stringify({
          ...VALID,
          contracts: [{ ...VALID.contracts[0], ui: true }],
          design: {
            direction: "editorial",
            palette: ["teal", "#1a1a1a"],
            typeface: "Fraunces",
            notDoing: ["no second typeface"],
            ambition: "bold",
          },
        }),
      ),
    );
    expect(error.problems.join(" ")).toContain("palette[0]");
  });

  test("the planner prompt states the design block rule", () => {
    // If the model cannot see the rule, the validator's missing-design rejection
    // is a loophole the model will walk through every time.
    const { PLANNER_PROMPT } = require("../../src/contracts/schema") as { PLANNER_PROMPT: string };
    expect(PLANNER_PROMPT).toContain("UI-capable plans MUST carry a \"design\" block");
  });

  test("the parser accepts a plan with context", () => {
    const withContext = parsePlan(
      JSON.stringify({
        ...VALID,
        context: {
          problem: "Teams waste time coordinating task status",
          users: "Hackathon teams",
          useCases: ["Create a board, add tasks"],
          benefits: ["Zero setup, real-time sync"],
          demoFlow: ["1. Open URL, 2. Create board"],
          futureWork: ["User accounts, mobile app"],
          marketOpportunity: "Task management tools market is $5B and growing",
          businessModel: "Freemium with paid team features",
          competitiveAdvantage: "Single-file deployment, no setup",
          goToMarket: "Post on Product Hunt and hackathon discords",
          risks: ["Scope creep, limited team availability"],
          currentStatus: "Prototype",
          ask: ["Feedback, beta testers"],
        },
      }),
    );
    expect(withContext.context?.problem).toBe("Teams waste time coordinating task status");
    expect(withContext.context?.users).toBe("Hackathon teams");
    expect(withContext.context?.useCases).toEqual(["Create a board, add tasks"]);
    expect(withContext.context?.benefits).toEqual(["Zero setup, real-time sync"]);
    expect(withContext.context?.demoFlow).toEqual(["1. Open URL, 2. Create board"]);
    expect(withContext.context?.futureWork).toEqual(["User accounts, mobile app"]);
    expect(withContext.context?.marketOpportunity).toBe("Task management tools market is $5B and growing");
    expect(withContext.context?.businessModel).toBe("Freemium with paid team features");
    expect(withContext.context?.competitiveAdvantage).toBe("Single-file deployment, no setup");
    expect(withContext.context?.goToMarket).toBe("Post on Product Hunt and hackathon discords");
    expect(withContext.context?.risks).toEqual(["Scope creep, limited team availability"]);
    expect(withContext.context?.currentStatus).toBe("Prototype");
    expect(withContext.context?.ask).toEqual(["Feedback, beta testers"]);
  });

  test("a graph with no dependencies may declare zero edges", () => {
    // A fan-out with no dependencies between its contracts has exactly zero
    // edges. Requiring a positive number made that unrepresentable, and the
    // planner declared an edge that did not exist to get past it.
    const parsed = parsePlan(
      JSON.stringify({ ...VALID, graphBudget: { ...VALID.graphBudget, edges: 0 } }),
    );
    expect(parsed.graphBudget.edges).toBe(0);
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
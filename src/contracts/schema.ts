import type { Contract, Plan } from "./types";

/**
 * JSON Schema constraining what the coordinator may emit.
 *
 * This is the boundary that keeps D2 honest. The model cannot invent fields
 * because the schema rejects them, and it cannot omit the ones the validator
 * requires — so an invalid plan is caught before any spend, not after.
 *
 * Draft 2020-12. Kept dependency-free rather than pulling in a validator: the
 * coordinator needs `additionalProperties: false` everywhere to have teeth, and
 * a structural check is cheaper to reason about than a library's dialect.
 */

const globArray = {
  type: "array",
  items: { type: "string", minLength: 1 },
} as const;

const step = {
  type: "object",
  additionalProperties: false,
  required: ["id", "description", "writes"],
  properties: {
    id: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    writes: globArray,
    check: { type: "string", minLength: 1 },
  },
} as const;

const check = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "command", "expectation", "gating", "convergent"],
  properties: {
    id: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ["baseline", "coverage", "intent", "judgment"] },
    command: { type: "string", minLength: 1 },
    expectation: { type: "string", minLength: 1 },
    gating: { type: "string", enum: ["blocking", "advisory"] },
    convergent: { type: "boolean" },
  },
} as const;

const budget = {
  type: "object",
  additionalProperties: false,
  required: ["tokens", "toolCalls", "wallMs"],
  properties: {
    tokens: { type: "integer", exclusiveMinimum: 0 },
    toolCalls: { type: "integer", exclusiveMinimum: 0 },
    wallMs: { type: "integer", exclusiveMinimum: 0 },
  },
} as const;

const contract = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "objective",
    "reads",
    "writes",
    "forbidden",
    "deliverable",
    "schema",
    "doneWhen",
    "checks",
    "budget",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    objective: { type: "string", minLength: 1 },
    reads: globArray,
    writes: globArray,
    forbidden: globArray,
    deliverable: { type: "string", enum: ["diff", "report", "data"] },
    schema: { type: "object" },
    doneWhen: { type: "string", minLength: 1 },
    checks: { type: "array", items: check },
    steps: { type: "array", items: step },
    budget,
    tools: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export const planSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["topology", "contracts", "graphBudget"],
  properties: {
    topology: {
      type: "string",
      enum: ["fan-out", "pipeline", "shared-context", "refuse"],
    },
    summary: {
      type: "string",
      minLength: 1,
      description:
        "Human-readable description of what this project is, for the founder. " +
        "Rendered at the top of CUBICORE_PLAN.md.",
    },
    context: {
      type: "object",
      additionalProperties: false,
      properties: {
        problem: {
          type: "string",
          minLength: 1,
          description: "What problem does this solve? One or two sentences.",
        },
        users: {
          type: "string",
          minLength: 1,
          description: "Who is this for? Target users or audience.",
        },
        useCases: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "What can someone do with this? Concrete scenarios.",
        },
        benefits: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Why this over alternatives? What makes it worth building?",
        },
        demoFlow: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "What to show live in a demo? Step-by-step flow.",
        },
        futureWork: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Where could this go next? Future directions.",
        },
        marketOpportunity: {
          type: "string",
          minLength: 1,
          description: "Market opportunity — TAM, who pays, how big is the market.",
        },
        businessModel: {
          type: "string",
          minLength: 1,
          description: "Business model — how does this make money or sustain itself?",
        },
        competitiveAdvantage: {
          type: "string",
          minLength: 1,
          description: "Competitive advantage — what's hard to copy, what's the moat.",
        },
        goToMarket: {
          type: "string",
          minLength: 1,
          description: "Go-to-market — how do you get the first 100 users?",
        },
        risks: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Risks — what could go wrong, what are the unknowns.",
        },
        currentStatus: {
          type: "string",
          minLength: 1,
          description: "Current status — idea, prototype, MVP, live, etc.",
        },
        ask: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "The ask — what do you need: team members, funding, partnerships, feedback.",
        },
      },
      required: [
        "problem", "users", "useCases", "benefits", "demoFlow", "futureWork",
        "marketOpportunity", "businessModel", "competitiveAdvantage", "goToMarket",
        "risks", "currentStatus", "ask",
      ],
    },
    contracts: { type: "array", items: contract },
    try: {
      type: "object",
      additionalProperties: false,
      description:
        "How to run the delivered thing, and what working looks like. A contract can be " +
        "correct and still not start, and no assertion on the code can find that.",
      required: ["command"],
      properties: {
        command: { type: "string", minLength: 1, description: "The command that starts it." },
        url: { type: "string", description: "A URL to poll until the thing answers." },
        readyTimeoutMs: { type: "integer", exclusiveMinimum: 0, description: "How long to wait for readiness." },
        readyLine: { type: "string", description: "A line in the output that means it is ready." },
        expect: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "integer", description: "The status the URL should answer with." },
            bodyContains: { type: "string", description: "A string the body must contain." },
          },
        },
      },
    },
    graphBudget: {
      type: "object",
      additionalProperties: false,
      required: ["nodes", "edges", "tokens", "wallMs"],
      properties: {
        nodes: { type: "integer", exclusiveMinimum: 0 },
        edges: { type: "integer", minimum: 0 },
        tokens: { type: "integer", exclusiveMinimum: 0 },
        wallMs: { type: "integer", exclusiveMinimum: 0 },
      },
    },
  },
} as const;

export const PLAN_SCHEMA_JSON = JSON.stringify(planSchema);

/**
 * The coordinator's contract, as prose. Deliberately states the refusals:
 * a planner that never says no will invent a five-way split of a rename and
 * hand the user four merge conflicts.
 */
export const PLANNER_PROMPT = `You are the coordinator for Cubicore. Split the user's request into contracts, or refuse to split it.

Respond with JSON matching this schema exactly. No prose, no code fences.

${PLAN_SCHEMA_JSON}

Rules:

- Each contract is one worker. Its "writes" globs MUST NOT overlap another
  contract's "writes" globs. Two workers writing the same file is the one
  failure this system exists to prevent.
- "reads" MAY overlap. Sharing read scope is fine and often desirable.
- "summary" is a human-readable description of what this project is. Write one
  or two sentences so the founder can understand the product at a glance,
  without reading every contract. It goes at the top of CUBICORE_PLAN.md.
- Every contract MUST have a "schema" field — an object describing the
  output it produces. A contract without a schema is invalid and will be
  rejected before anything is spent.
- A contract producing a "diff" needs at least one check with
  "gating": "blocking".
- A blocking check must have "convergent": true. Typecheck and tests converge.
  Coverage thresholds and complexity limits do not — mark those "advisory".
- Prefer "intent" checks derived from what the user actually asked for. You
  have not read the code, so do not guess at this file's edge cases.
- "tools" lists the MCP servers or plugins this contract will use. The host
  may have many registered; declare only the ones this contract needs.
  Empty array means none — the worker runs with the base tool set only.
- "graphBudget.edges" must be at least the number of read/write dependencies
  between contracts — count every case where one contract "reads" a path that
  another contract "writes". Under-funding the edges rejects the plan.
- "graphBudget.nodes" must be at least the number of contracts.
- "steps" within a contract are ordered sub-tasks. Each step writes its own
  files and can be tracked independently so an interrupted run can resume
  from completed steps rather than restarting the whole contract.
- The founder may describe the split in any terms — team members, phases,
  milestones, parts, pieces, however they like. The number matters, not the
  words. Translate whatever they say into contracts with disjoint write
  scopes and a graph budget that funds them.
- "context" is narrative information for human readers, not for dispatch.
  It describes the problem, users, use cases, benefits, demo flow, future
  work, market opportunity, business model, competitive advantage, go-to-market,
  risks, current status, and the ask — everything a recruiter or stakeholder
  needs to evaluate the idea. It is rendered at the top of CUBICORE_CONTEXT.md
  and never affects what gets built.

Refusing is a valid answer. Use topology "refuse" with an empty contracts
array when the request:
  - changes a public interface, type, or shared config
  - is a rename, migration, or cross-cutting refactor
  - is a dependent chain such as read, then edit, then test, then fix
  - is too small to be worth splitting

Set topology "pipeline" for dependent stages, and "shared-context" when one
worker should read the files and the rest work from its summary.`;

export const REPLAN_PROMPT = `The previous plan was rejected. Here are the validation findings:

{findings}

Produce a corrected plan as JSON matching the same schema. Resolve every
finding. If the findings show the request cannot be split safely, return
topology "refuse" with an empty contracts array instead.`;
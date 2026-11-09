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

const role = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    capabilities: globArray,
    tools: {
      type: "object",
      additionalProperties: false,
      properties: {
        allow: globArray,
        deny: globArray,
      },
    },
    handoff: {
      type: "object",
      additionalProperties: false,
      required: ["deliverable", "audience"],
      properties: {
        deliverable: { type: "string", minLength: 1 },
        audience: { type: "string", minLength: 1 },
      },
    },
    exclusions: globArray,
    escalation: { type: "string", minLength: 1 },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: {
        tokens: { type: "integer", minimum: 100 },
        toolCalls: { type: "integer", minimum: 1 },
        wallMs: { type: "integer", minimum: 1000 },
      },
    },
  },
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
    ui: {
      type: "boolean",
      description:
        "True for any screen-facing contract. Triggers the design requirement.",
    },
    role,
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
      maxLength: 400,
      description:
        "Human-readable description of what this project is, for the founder. " +
        "Rendered at the top of CUBICORE_PLAN.md.",
    },
    opinion: {
      type: "string",
      maxLength: 500,
      description:
        "The planner's argument for the build in full. What the founder did " +
        "not say and an expert would include by default, what is deliberately " +
        "left out, and why. One paragraph, at most two sentences. Advice, " +
        "not a contract: the dispatcher never reads it and the founder can " +
        "strike it for free in refine.",
    },
    integration: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", minLength: 1 },
        timeoutMs: { type: "number", minimum: 1000, maximum: 900000 },
      },
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
    preview: {
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
            outputContains: { type: "string", description: "A string somewhere in the command's output that means it works (CLI/TUI/GUI)." },
          },
        },
      },
    },
    design: {
      type: "object",
      additionalProperties: false,
      required: ["direction", "palette", "typeface", "notDoing", "ambition"],
      properties: {
        direction: { type: "string", minLength: 1 },
        palette: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: { type: "string", pattern: "^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$" },
        },
        typeface: { type: "string", minLength: 1 },
        typeScale: { type: "number", exclusiveMinimum: 1, maximum: 1.5 },
        spacing: { type: "number", exclusiveMinimum: 0 },
        radii: { type: "array", maxItems: 2, items: { type: "integer", minimum: 0 } },
        signature: { type: "string" },
        notDoing: { type: "array", items: { type: "string", minLength: 1 } },
        ambition: { type: "string", enum: ["calm", "standard", "bold"] },
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
- "opinion" is the planner's argument for the build in full — what the founder
  would want if they knew exactly what to ask for, what is deliberately left
  out, and why. One paragraph, at most two sentences, ~400 characters. Advice,
  not a contract: it is not dispatched, and the founder can strike it for free.
- "integration" (optional) is one command proving the merged tree works:
  the build command, the typecheck command, etc. It runs after verification,
  before the factory says done. A hung command must not hang the factory —
  include "timeoutMs" if the command might exceed 120000 (2 minutes default).
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
- UI-capable plans MUST carry a "design" block. UI-capable means: any
  contract with "ui": true, or any "writes" glob ending in a screen-facing
  extension (.html, .css, .jsx, .tsx, .svelte, .vue, .astro, .scss/.sass/.less).
  A plan with a UI contract but no design block is REJECTED by the validator
  before dispatch — the design is part of the contract, not decoration.
- For UI-capable plans, pick ONE named direction whose tokens actually
  belong to that direction. Do NOT default to "white cards, blue accent,
  Inter, rounded corners" unless the founder explicitly asked for that.
  The choice must be characterful enough that a stranger could tell the
  product apart from a competitor on silhouette alone.

  Catalog (use verbatim when the founder's brief matches):
  - "editorial porcelain" — serif display (Fraunces/GT Sectra) + humanist sans body, warm off-white background, ink-black text, one bold accent (tomato/ochre/forest), serif scale ~1.4×, input spacing wide.
  - "dark editorial" — black or deep navy ground, high-contrast display serif or grotesque, cream text, one warm accent, generous negative space.
  - "terminal-first" — monospace everything, dark ground with phosphor green or amber on near-black, status-line layout, box-drawing separators.
  - "maximalist pop" — saturated background block (not white), two strong clashes (e.g. tomato on ochre), bold display face, confident motion.
  - "hand-drawn warmth" — off-cream ground, felt-pen illustration accents, rounded corners, serif/sans pairing, sun-but-not-flat illustration style.
  - "porcelain minimal" — near-white warm ground, one elegant serif display, hairline borders, no shadows unless brand-appropriate.

  Pick ONE. Record it in the plan with a reason. The founder, never you,
  decides — if the founder named a mood that maps to a direction, use it.
  If nothing matches, invent a SPECIFIC direction with a name you'd be proud
  to explain, not a generic tag.
- design.notDoing is the load-bearing list — small, specific prohibitions
  the frontend must never cross ("no scrolljacking", "no second typeface"),
  not general aspirations.

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

- **Build exactly what the user requested.** The "User request" below is the
  source of truth. Do not substitute your own project idea, do not upgrade it
  to something "bigger" or "more impressive", and do not build something else
  when the user asked for something specific. If the user's request is too
  vague to split, return topology "refuse" rather than guessing what they meant.

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
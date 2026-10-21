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
    budget,
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
        edges: { type: "integer", exclusiveMinimum: 0 },
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
- A contract producing a "diff" needs at least one check with
  "gating": "blocking".
- A blocking check must have "convergent": true. Typecheck and tests converge.
  Coverage thresholds and complexity limits do not — mark those "advisory".
- Prefer "intent" checks derived from what the user actually asked for. You
  have not read the code, so do not guess at this file's edge cases.

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
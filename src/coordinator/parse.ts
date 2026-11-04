import type { Check, Contract, Finding, Plan, PlanContext, Step, Topology } from "../contracts/types";
import type { PreviewSpec } from "../plan/preview";

/**
 * Runtime validation against the emitted schema's shape.
 *
 * Deliberately hand-rolled rather than pulling in a JSON Schema validator. The
 * coordinator boundary needs `additionalProperties: false` and enum checks, and
 * that is a hundred lines to express directly. A full validator is a dependency
 * we would then have to keep in sync with the schema above.
 *
 * This checks structure only. Semantics — disjoint writes, blocking checks,
 * budget ceilings — belong to `validatePlan`, which already exists and is
 * tested.
 */

export class MalformedPlan extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = "MalformedPlan";
  }
}

const TOPOLOGIES: readonly Topology[] = [
  "fan-out",
  "pipeline",
  "shared-context",
  "refuse",
];

const DELIVERABLES = ["diff", "report", "data"];
const CHECK_KINDS = ["baseline", "coverage", "intent", "judgment"];
const GATINGS = ["blocking", "advisory"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkGlobArray(
  value: unknown,
  label: string,
  problems: string[],
): string[] {
  if (!Array.isArray(value)) {
    problems.push(`${label} must be an array`);
    return [];
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      problems.push(`${label}[${index}] must be a non-empty string`);
    } else {
      out.push(entry);
    }
  }
  return out;
}

function checkPositiveInt(
  value: unknown,
  label: string,
  problems: string[],
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    problems.push(`${label} must be a positive number`);
    return 0;
  }
  return value;
}

/**
 * A count that may legitimately be zero.
 *
 * The edge count is one: a fan-out with no dependencies between its contracts
 * has exactly zero edges, and requiring a positive number made that
 * unrepresentable. The planner declared an edge that did not exist to get
 * past it, which is worse than a wrong number in a file nobody reads.
 */
function checkNonNegativeInt(
  value: unknown,
  label: string,
  problems: string[],
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    problems.push(`${label} must be zero or a positive number`);
    return 0;
  }
  return value;
}

function parseCheck(value: unknown, label: string, problems: string[]): Check | null {
  if (!isRecord(value)) {
    problems.push(`${label} must be an object`);
    return null;
  }

  const allowed = ["id", "kind", "command", "expectation", "gating", "convergent"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${label} has unknown field "${key}"`);
  }

  const text = (key: string): string => {
    const raw = value[key];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      problems.push(`${label}.${key} must be a non-empty string`);
      return "";
    }
    return raw;
  };

  const kind = text("kind");
  if (kind && !CHECK_KINDS.includes(kind)) {
    problems.push(`${label}.kind "${kind}" is not a known check kind`);
  }

  const gating = text("gating");
  if (gating && !GATINGS.includes(gating)) {
    problems.push(`${label}.gating "${gating}" is not blocking or advisory`);
  }

  const convergent = value.convergent;
  if (typeof convergent !== "boolean") {
    problems.push(`${label}.convergent must be a boolean`);
  }

  if (problems.length > 0) return null;

  return {
    id: value.id as string,
    kind: kind as Check["kind"],
    command: value.command as string,
    expectation: value.expectation as string,
    gating: gating as Check["gating"],
    convergent: convergent as boolean,
  };
}

function parseContract(value: unknown, label: string, problems: string[]): Contract | null {
  if (!isRecord(value)) {
    problems.push(`${label} must be an object`);
    return null;
  }

  const allowed = [
    "id", "objective", "reads", "writes", "forbidden",
    "deliverable", "schema", "doneWhen", "checks", "steps", "budget",
    "tools",
  ];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${label} has unknown field "${key}"`);
  }

  const text = (key: string): string => {
    const raw = value[key];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      problems.push(`${label}.${key} must be a non-empty string`);
      return "";
    }
    return raw;
  };

  const deliverable = text("deliverable");
  if (deliverable && !DELIVERABLES.includes(deliverable)) {
    problems.push(`${label}.deliverable "${deliverable}" is not a known deliverable`);
  }

  if (!isRecord(value.schema)) problems.push(`${label}.schema must be an object`);

  const checksRaw = value.checks;
  if (!Array.isArray(checksRaw)) {
    problems.push(`${label}.checks must be an array`);
  }
  const checks = Array.isArray(checksRaw)
    ? checksRaw
        .map((entry, index) => parseCheck(entry, `${label}.checks[${index}]`, problems))
        .filter((entry): entry is Check => entry !== null)
    : [];

  const stepsRaw = value.steps;
  let steps: Step[] | undefined;
  if (stepsRaw !== undefined && stepsRaw !== null) {
    if (!Array.isArray(stepsRaw)) {
      problems.push(`${label}.steps must be an array`);
    } else {
      steps = stepsRaw
        .map((entry, index) => parseStep(entry, `${label}.steps[${index}]`, problems))
        .filter((entry): entry is Step => entry !== null);
    }
  }

  const budgetRaw = value.budget;
  let budget = { tokens: 0, toolCalls: 0, wallMs: 0 };
  if (!isRecord(budgetRaw)) {
    problems.push(`${label}.budget must be an object`);
  } else {
    for (const key of Object.keys(budgetRaw)) {
      if (!["tokens", "toolCalls", "wallMs"].includes(key)) {
        problems.push(`${label}.budget has unknown field "${key}"`);
      }
    }
    budget = {
      tokens: checkPositiveInt(budgetRaw.tokens, `${label}.budget.tokens`, problems),
      toolCalls: checkPositiveInt(budgetRaw.toolCalls, `${label}.budget.toolCalls`, problems),
      wallMs: checkPositiveInt(budgetRaw.wallMs, `${label}.budget.wallMs`, problems),
    };
  }

  if (problems.length > 0) return null;

  return {
    id: value.id as string,
    objective: value.objective as string,
    reads: checkGlobArray(value.reads, `${label}.reads`, []),
    writes: checkGlobArray(value.writes, `${label}.writes`, []),
    forbidden: checkGlobArray(value.forbidden, `${label}.forbidden`, []),
    deliverable: deliverable as Contract["deliverable"],
    schema: value.schema as Record<string, unknown>,
    doneWhen: value.doneWhen as string,
    checks,
    ...(steps ? { steps } : {}),
    budget,
    tools: Array.isArray(value.tools) ? value.tools as string[] : [],
  };
}

/**
 * Parse a single step within a contract.
 */
function parseStep(value: unknown, label: string, problems: string[]): Step | null {
  if (!isRecord(value)) {
    problems.push(`${label} must be an object`);
    return null;
  }

  const allowed = ["id", "description", "writes", "check"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${label} has unknown field "${key}"`);
  }

  const id = textField(value.id, `${label}.id`, problems);
  const description = textField(value.description, `${label}.description`, problems);

  const writesRaw = value.writes;
  let writes: string[] = [];
  if (!Array.isArray(writesRaw)) {
    problems.push(`${label}.writes must be an array`);
  } else {
    writes = writesRaw
      .map((w, i) => {
        if (typeof w !== "string" || w.trim().length === 0) {
          problems.push(`${label}.writes[${i}] must be a non-empty string`);
          return null;
        }
        return w.trim();
      })
      .filter((w): w is string => w !== null);
  }

  const checkRaw = value.check;
  let check: string | undefined;
  if (checkRaw !== undefined && checkRaw !== null) {
    if (typeof checkRaw !== "string" || checkRaw.trim().length === 0) {
      problems.push(`${label}.check must be a non-empty string`);
    } else {
      check = checkRaw.trim();
    }
  }

  if (problems.length > 0) return null;

  return { id, description, writes, ...(check ? { check } : {}) };
}

function textField(value: unknown, label: string, problems: string[]): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    problems.push(`${label} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

/**
 * Parse a coordinator response into a `Plan`, or throw `MalformedPlan`.
 *
 * Throwing rather than returning a result union is deliberate: a malformed plan
 * is an exceptional path that ends in a serial fallback, and the caller needs it
 * to be unmistakable at the call site.
 */
export function parsePlan(raw: string): Plan {
  const problems: string[] = [];

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new MalformedPlan("coordinator response was not valid JSON", [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  if (!isRecord(json)) {
    throw new MalformedPlan("coordinator response was not a JSON object", [
      "expected an object at the top level",
    ]);
  }

  for (const key of Object.keys(json)) {
    if (!["topology", "summary", "context", "contracts", "graphBudget", "preview"].includes(key)) {
      problems.push(`plan has unknown field "${key}"`);
    }
  }

  const topologyRaw = json.topology;
  if (typeof topologyRaw !== "string" || !TOPOLOGIES.includes(topologyRaw as Topology)) {
    problems.push(`topology must be one of ${TOPOLOGIES.join(", ")}`);
  }

  const contractsRaw = json.contracts;
  if (!Array.isArray(contractsRaw)) {
    problems.push("contracts must be an array");
  }
  const contracts = Array.isArray(contractsRaw)
    ? contractsRaw
        .map((entry, index) => parseContract(entry, `contracts[${index}]`, problems))
        .filter((entry): entry is Contract => entry !== null)
    : [];

  const graphRaw = json.graphBudget;
  let graphBudget = { nodes: 0, edges: 0, tokens: 0, wallMs: 0 };
  if (!isRecord(graphRaw)) {
    problems.push("graphBudget must be an object");
  } else {
    for (const key of Object.keys(graphRaw)) {
      if (!["nodes", "edges", "tokens", "wallMs"].includes(key)) {
        problems.push(`graphBudget has unknown field "${key}"`);
      }
    }
    graphBudget = {
      nodes: checkPositiveInt(graphRaw.nodes, "graphBudget.nodes", problems),
      edges: checkNonNegativeInt(graphRaw.edges, "graphBudget.edges", problems),
      tokens: checkPositiveInt(graphRaw.tokens, "graphBudget.tokens", problems),
      wallMs: checkPositiveInt(graphRaw.wallMs, "graphBudget.wallMs", problems),
    };
  }

  if (problems.length > 0) {
    throw new MalformedPlan("coordinator response did not match the plan schema", problems);
  }

  const summaryRaw = json.summary;
  let summary: string | undefined;
  if (summaryRaw !== undefined && summaryRaw !== null) {
    if (typeof summaryRaw !== "string" || summaryRaw.trim().length === 0) {
      problems.push("summary must be a non-empty string");
    } else {
      summary = summaryRaw.trim();
    }
  }

  const contextRaw = json.context;
  let context: PlanContext | undefined;
  if (contextRaw !== undefined && contextRaw !== null) {
    if (!isRecord(contextRaw)) {
      problems.push("context must be an object");
    } else {
      const ctx = contextRaw as Record<string, unknown>;
      const contextProblems: string[] = [];
      const requiredFields = [
        "problem", "users", "useCases", "benefits", "demoFlow", "futureWork",
        "marketOpportunity", "businessModel", "competitiveAdvantage", "goToMarket",
        "risks", "currentStatus", "ask",
      ];
      for (const field of requiredFields) {
        if (!(field in ctx)) {
          contextProblems.push(`context.${field} is required`);
        }
      }
      if (contextProblems.length === 0) {
        context = ctx as unknown as PlanContext;
      } else {
        for (const p of contextProblems) problems.push(`context: ${p}`);
      }
    }
  }

  return {
    topology: topologyRaw as Topology,
    summary,
    context,
    contracts,
    graphBudget,
    preview: parsePreview(json.preview, problems),
  };
}

/**
 * The optional run block.
 *
 * Parsed, not merely tolerated. When `preview` was added to the schema the
 * parser's key list was never updated, so every plan carrying one was
 * rejected -- and once the key was allowed, the value was read from nowhere
 * and silently dropped, so the run instructions vanished between the plan
 * file and the dispatcher.
 */
function parsePreview(value: unknown, problems: string[]): PreviewSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    problems.push("preview must be an object");
    return undefined;
  }

  const command = value.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    problems.push("preview.command must be a non-empty string");
    return undefined;
  }

  const spec: PreviewSpec = { command };

  if (value.url !== undefined) {
    if (typeof value.url !== "string") problems.push("preview.url must be a string");
    else spec.url = value.url;
  }
  if (value.readyLine !== undefined) {
    if (typeof value.readyLine !== "string") problems.push("preview.readyLine must be a string");
    else spec.readyLine = value.readyLine;
  }
  if (value.readyTimeoutMs !== undefined) {
    if (typeof value.readyTimeoutMs !== "number" || !Number.isFinite(value.readyTimeoutMs) || value.readyTimeoutMs <= 0) {
      problems.push("preview.readyTimeoutMs must be a positive number");
    } else {
      spec.readyTimeoutMs = value.readyTimeoutMs;
    }
  }
  if (value.expect !== undefined) {
    if (!isRecord(value.expect)) {
      problems.push("preview.expect must be an object");
    } else {
      const expect: PreviewSpec["expect"] = {};
      if (value.expect.status !== undefined) {
        if (typeof value.expect.status !== "number") problems.push("preview.expect.status must be a number");
        else expect.status = value.expect.status;
      }
      if (value.expect.bodyContains !== undefined) {
        if (typeof value.expect.bodyContains !== "string") problems.push("preview.expect.bodyContains must be a string");
        else expect.bodyContains = value.expect.bodyContains;
      }
      spec.expect = expect;
    }
  }

  return spec;
}

export function formatFindings(findings: Finding[]): string {
  return findings
    .map((finding) => `- [${finding.code}] ${finding.message}`)
    .join("\n");
}
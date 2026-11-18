import type {
  Check,
  Contract,
  Finding,
  Plan,
  ValidationResult,
} from "../contracts/types";
import { overlapPairs, overlaps } from "./overlap";
import { findDependencies } from "../coordinator/topology";
import { assertBaselineIntact, effectiveMatrix, validateChecks } from "./matrix";

function isBlank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

function checkContract(contract: Contract, seen: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const at = [contract.id];

  if (seen.has(contract.id)) {
    findings.push({
      code: "duplicate-id",
      contractIds: at,
      message: `duplicate contract id "${contract.id}"`,
    });
  }
  seen.add(contract.id);

  if (isBlank(contract.objective)) {
    findings.push({
      code: "missing-objective",
      contractIds: at,
      message: `contract "${contract.id}" has no objective`,
    });
  }

  if (
    !contract.schema ||
    typeof contract.schema !== "object" ||
    Object.keys(contract.schema).length === 0
  ) {
    findings.push({
      code: "missing-schema",
      contractIds: at,
      message: `contract "${contract.id}" has no output schema`,
    });
  }

  if (isBlank(contract.doneWhen)) {
    findings.push({
      code: "missing-done-when",
      contractIds: at,
      message: `contract "${contract.id}" has no doneWhen condition`,
    });
  }

  const { tokens, toolCalls, wallMs } = contract.budget ?? {};
  if (
    !(tokens > 0) ||
    !(toolCalls > 0) ||
    !(wallMs > 0)
  ) {
    findings.push({
      code: "invalid-budget",
      contractIds: at,
      message: `contract "${contract.id}" has a non-positive budget`,
    });
  }

  findings.push(...validateChecks(contract.checks ?? [], contract.id));

  // A code artifact with no runnable gate can only be judged by an LLM reading
  // a diff, which is the untrustworthy path D9 exists to avoid.
  const hasBlocking = (contract.checks ?? []).some(
    (check) => check.gating === "blocking",
  );
  if (contract.deliverable === "diff" && !hasBlocking) {
    findings.push({
      code: "no-blocking-check",
      contractIds: at,
      message: `contract "${contract.id}" produces a diff but declares no blocking check, so nothing can verify it`,
    });
  }

  return findings;
}

function checkPair(a: Contract, b: Contract): Finding[] {
  const findings: Finding[] = [];
  const ids = [a.id, b.id];

  const collisions = overlapPairs(a.writes, b.writes);
  if (collisions.length > 0) {
    const detail = collisions
      .map(([left, right]) => `"${left}" ∩ "${right}"`)
      .join(", ");
    findings.push({
      code: "write-collision",
      contractIds: ids,
      message: `contracts "${a.id}" and "${b.id}" may write the same files: ${detail}`,
    });
  }

  if (overlaps(a.writes, b.forbidden) || overlaps(b.writes, a.forbidden)) {
    findings.push({
      code: "writes-forbidden",
      contractIds: ids,
      message: `contracts "${a.id}" and "${b.id}" have write sets inside each other's forbidden globs`,
    });
  }

  return findings;
}

/**
 * UI-capable means the plan will produce something a founder can look at.
 * Detected conservatively: either a contract marks itself `ui: true`, or a
 * writes glob targets a screen-facing file format. There is no opt-out by
 * accident — a back-end plan with a stray `ui: true` is rejected the same
 * as one with a real one, and the founder can override by refining.
 */
const UI_WRITES = /\.(?:html?|css|scss|sass|less|jsx|tsx|svelte|vue|astro|styl?|html)$/i;

export function isUiCapable(plan: Plan): boolean {
  return plan.contracts.some((c) => c.ui === true || c.writes.some((w) => UI_WRITES.test(w)));
}

/**
 * Every UI-capable plan must carry acceptance — the user-facing promise,
 * expressed as a runnable check. Without it, selectors and builds verify
 * mechanics only, and the product must never be claimed.
 */
function checkAcceptance(plan: Plan): Finding[] {
  if (!isUiCapable(plan)) return [];
  if ((plan.acceptance?.length ?? 0) === 0) {
    const ids = plan.contracts.map((c) => c.id);
    return [
      {
        code: "missing-acceptance",
        contractIds: ids,
        message:
          "plan is UI-capable but declares no acceptance cases. Add a top-level " +
          "\"acceptance\" array with at least one entry per user-facing promise from " +
          "the brief — each entry: { name, command }. The command must FAIL when the " +
          "promise is broken and PASS when it holds (a browser-smoke `npx playwright test` " +
          "in at least one case).",
      },
    ];
  }
  return [];
}

import { bestPairContrast } from "./luminance";

/**
 * UI-capable plans carry the founder's taste already, as one named thing they
 * approved — not a mood word, not a genre default. Without a reference, the
 * plan can only produce the dataset mean: polished, generic, thrown away.
 */
function checkReference(plan: Plan): Finding[] {
  if (!isUiCapable(plan)) return [];
  const ref = (plan as Plan & { reference?: string }).reference;
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  const ok = trimmed.length > 0 && (
    /^https?:\/\//i.test(trimmed) ||
    trimmed.startsWith("file://") ||
    (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.includes(" "))
  );
  if (ok) return [];
  const ids = plan.contracts.map((c) => c.id);
  return [
    {
      code: "missing-reference",
      contractIds: ids,
      message:
        "plan is UI-capable but carries no reference; the planner must record a " +
        "reference verbatim as the plan's top-level 'reference' field — a URL, a " +
        "file path (file:// or /abs/path), or an attached image described in the " +
        "brief. If none is present in the brief, the planner must webfetch one. " +
        "The planner must NOT ask the founder. " +
        "A mood word like 'sunset' is not a reference. A plan without one produces " +
        "exactly the average of everything you already know",
    },
  ];
}

function checkDesign(plan: Plan): Finding[] {
  if (!isUiCapable(plan)) return [];
  if (plan.design && plan.design.palette.length >= 2 && plan.design.notDoing.length > 0) {
    const best = bestPairContrast(plan.design.palette);
    if (best < 4.5) {
      const ids = plan.contracts.map((c) => c.id);
      return [
        {
          code: "weak-contrast-palette",
          contractIds: ids,
          message:
            `best contrast ratio across the declared palette is ${best.toFixed(2)}; body text needs 4.5. ` +
            "Adjust the palette so at least one pair clears the bar (light text on dark or vice versa).",
        },
      ];
    }
    return [];
  }
  const ids = plan.contracts.map((c) => c.id);
  return [
    {
      code: "missing-design",
      contractIds: ids,
      message:
        plan.design
          ? `plan is UI-capable and a design block exists but is underspecified; the design must name direction, palette (2-4 hex), typeface, notDoing, and ambition`
          : `plan is UI-capable (writes touch screen-facing files) but has no design block; the planner must propose a direction and the founder must pick one`,
    },
  ];
}

/**
 * A UI-capable plan must prove the app actually boots and its core flow works
 * — not merely that it compiles and passes unit tests. Before this gate, the
 * factory shipped visually polished apps whose buttons did nothing. The smoke
 * contract is ordinary: one blocking, convergent check that launches the
 * built app and walks the core flow with a browser driver. Playwright,
 * Cypress and Puppeteer all count; unit tests and `tsc` do not.
 */
const SMOKE_COMMAND = /playwright|cypress|puppeteer/i;

export function hasUiSmoke(plan: Plan): boolean {
  // Acceptance entries proven in the product flows count here too — they are
  // precisely the same check material, shaped as product-level journeys.
  if (
    plan.acceptance?.some((acceptance) => SMOKE_COMMAND.test(acceptance.command))
  ) {
    return true;
  }
  return plan.contracts.some((contract) =>
    (contract.checks ?? []).some((check) => SMOKE_COMMAND.test(check.command))
  );
}

function checkUiSmoke(plan: Plan): Finding[] {
  if (!isUiCapable(plan)) return [];
  if (hasUiSmoke(plan)) return [];
  const hasAcceptance = (plan.acceptance?.length ?? 0) > 0;
  const ids = plan.contracts.map((c) => c.id);
  if (hasAcceptance) {
    // Acceptance entries exist but none exercises the built app in a browser.
    // That is almost always a lazy suite — any useful acceptance will click
    // through the real interface at least once.
    return [
      {
        code: "acceptance-no-browser",
        contractIds: ids,
        message:
          "plan is UI-capable and carries acceptance cases, but none of them drives a browser. " +
          "At least one acceptance command must exercise the built app in a real browser — " +
          "`npx playwright test` is the common shape; the rest can be headless.",
      },
    ];
  }
  return [
    {
      code: "missing-ui-smoke",
      contractIds: ids,
      message:
        "plan is UI-capable but no contract or acceptance case exercises the built app " +
        "in a browser; add acceptance cases (top-level \"acceptance\" array) pointing at " +
        "the built surface with a browser driver such as `npx playwright test`. Without it, " +
        "a dead button ships as \"done\".",
    },
  ];
}

/**
 * A contract that writes more than a dozen files is almost always a contract
 * that was actually two (or three) contracts. Inside this product's own
 * history: the only contract > 10 was `foundation` — it failed its own build
 * and needed orchestrator repairs post-dispatch. Refuse at plan time so the
 * planner splits before anything is spent.
 */
const MAX_WRITES_PER_CONTRACT = 12;

function checkContractSize(plan: Plan): Finding[] {
  const findings: Finding[] = [];
  for (const contract of plan.contracts) {
    if ((contract.writes?.length ?? 0) <= MAX_WRITES_PER_CONTRACT) continue;
    findings.push({
      code: "contract-too-big",
      contractIds: [contract.id],
      message:
        `contract "${contract.id}" writes ${contract.writes.length} files — more than ${MAX_WRITES_PER_CONTRACT}. ` +
        `This contract should be split in two at the plan level (e.g., "${contract.id}-core" and "${contract.id}-ui"). ` +
        "Refusing to dispatch as-is: it will either compound its own failure modes or land broken.",
    });
  }
  return findings;
}

function textsOf(plan: Plan): string[] {
  const parts: string[] = [];
  if (plan.summary) parts.push(plan.summary);
  if (plan.context?.problem) parts.push(plan.context.problem);
  if (plan.context?.ask) parts.push(...plan.context.ask);
  for (const contract of plan.contracts) {
    parts.push(contract.objective ?? "", contract.doneWhen ?? "");
    if (contract.steps) for (const step of contract.steps) parts.push(step.description);
  }
  return parts;
}

const ASSET_KEYWORDS = /\b(?:texture|sprite|asset|voxel|block|pixel)\b/i;

function checkAssets(plan: Plan): Finding[] {
  if (!isUiCapable(plan)) return [];
  if (!plan.design) return []; // missing-design covers that
  if (plan.design.assets && plan.design.assets.length >= 1) return [];
  const all = textsOf(plan);
  if (!all.some((t) => ASSET_KEYWORDS.test(t))) return [];
  const ids = plan.contracts.map((c) => c.id);
  return [
    {
      code: "missing-assets",
      contractIds: ids,
      message:
        "plan names textures/sprites/assets/voxels/blocks/pixels but declares no asset kit; " +
        "every asset the build produces must appear in design.assets as { name, kind, hex, note }, " +
        "so gateStyle can verify every hex in the diff appears in the palette or the assets list",
    },
  ];
}

function checkGraphBudget(plan: Plan): Finding[] {
  const findings: Finding[] = [];
  const ids = plan.contracts.map((c) => c.id);
  const budget = plan.graphBudget;

  if (!budget || budget.nodes < plan.contracts.length) {
    findings.push({
      code: "budget-exceeded",
      contractIds: ids,
      message: `graph budget allows ${budget?.nodes ?? 0} nodes but the plan declares ${plan.contracts.length} contracts`,
    });
    return findings;
  }

  const tokens = plan.contracts.reduce((sum, c) => sum + (c.budget?.tokens ?? 0), 0);
  if (tokens > budget.tokens) {
    findings.push({
      code: "budget-exceeded",
      contractIds: ids,
      message: `contract token budgets sum to ${tokens}, exceeding the graph ceiling of ${budget.tokens}`,
    });
  }

  // The edge ceiling is a budget like the others, and it was the one that
  // was not checked. A plan declaring 11 edges for a graph that needs 14
  // under-funds itself, and nothing said so -- the same class of quiet
  // inconsistency the whole system keeps hunting for.
  const requiredEdges = findDependencies(plan.contracts).length;
  if (requiredEdges > budget.edges) {
    findings.push({
      code: "budget-exceeded",
      contractIds: ids,
      message: `plan needs ${requiredEdges} dependency edges, exceeding the graph ceiling of ${budget.edges}`,
    });
  }

  const wallMs = plan.contracts.reduce((sum, c) => sum + (c.budget?.wallMs ?? 0), 0);
  if (wallMs > budget.wallMs) {
    findings.push({
      code: "budget-exceeded",
      contractIds: ids,
      message: `contract wall budgets sum to ${wallMs}ms, exceeding the graph ceiling of ${budget.wallMs}ms`,
    });
  }

  return findings;
}

export function validatePlan(
  plan: Plan,
  baseline: readonly Check[] = [],
): ValidationResult {
  if (plan.topology === "refuse") return { ok: true, findings: [] };

  const findings: Finding[] = [];

  if (plan.contracts.length === 0) {
    findings.push({
      code: "empty-plan",
      contractIds: [],
      message: "plan declares no contracts",
    });
    return { ok: false, findings };
  }

  const seen = new Set<string>();
  for (const contract of plan.contracts) {
    findings.push(...checkContract(contract, seen));
    findings.push(
      ...assertBaselineIntact(
        baseline,
        effectiveMatrix(baseline, contract.checks ?? []),
      ),
    );
  }

  for (let i = 0; i < plan.contracts.length; i++) {
    for (let j = i + 1; j < plan.contracts.length; j++) {
      findings.push(...checkPair(plan.contracts[i], plan.contracts[j]));
    }
  }

  findings.push(...checkDesign(plan));
  findings.push(...checkReference(plan));
  findings.push(...checkAssets(plan));
  findings.push(...checkUiSmoke(plan));
  findings.push(...checkAcceptance(plan));
  findings.push(...checkContractSize(plan));
  findings.push(...checkGraphBudget(plan));

  return { ok: findings.length === 0, findings };
}
import type { Contract, Plan } from "../contracts/types";

/**
 * One brief per associate.
 *
 * A fixed taxonomy -- frontend, backend, design, data -- does not survive
 * contact with real projects. A CLI, a plugin and a web app share no such
 * categories, and a hardcoded list forces the plan into them. So the tracks
 * come from the Main agent's own plan, which already knows what it is
 * building; nothing here guesses.
 *
 * Each associate gets its own file rather than a numbered section of one. A
 * sub-agent reads exactly one document and starts building, which is the
 * behaviour we want -- a shared file invites an associate to read another
 * associate's brief and wander into its write scope.
 */

export const ASSOCIATE_AGENT_ID = "cubicore-associate";

/**
 * Does this forbidden entry name a path, or is it prose?
 *
 * A planner writes constraints as sentences -- "do not modify src/types.ts,
 * src/counters.ts or package.json" -- and globs as paths. Treating a sentence
 * as a path made a brief list a file it owns under "other associates own
 * these", and the associate had to guess which half of the brief was true.
 */
function looksLikePath(entry: string): boolean {
  const trimmed = entry.trim();
  if (/\s/.test(trimmed)) return false;
  if (!trimmed.includes("/") && !trimmed.includes(".")) return false;
  return !trimmed.endsWith(".") && !trimmed.endsWith("!");
}

/** Directory the per-associate briefs are written to. */
export const BRIEF_DIR = "CUBICORE_ASSOCIATES";

export function associateAgentConfig(): Record<string, unknown> {
  return {
    description:
      "A Cubicore associate. Executes exactly one brief: a bounded write scope, a " +
      "deliverable, and checks that decide whether it passed. Never widens its own scope, " +
      "never reads another associate's brief, and never edits outside the files it was given.",
    mode: "subagent",
    temperature: 0,
    // The agent config is the tool wall — opencode 2.x drops any per-prompt
    // `tools` field, so restriction must live here. Deny-all, then allow
    // exactly the base tool kit. Wildcards address MCP tools by server
    // prefix; `cubicore_plan_mark` / `plan_mark` belt-and-suspenders allow
    // Cubicore's own tool under either namespace spelling.
    permission: {
      "*": "deny",
      read: "allow",
      edit: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "allow",
      webfetch: "allow",
      websearch: "allow",
      lsp: "allow",
      skill: "allow",
      question: "ask",
      task: "deny",
      external_directory: "deny",
      doom_loop: "deny",
      browser: "deny",
      plan_mark: "allow",
      cubicore_plan_mark: "allow",
    },
    prompt: [
      "You are a Cubicore associate. One brief, nothing else.",
      "",
      "Read the brief. It names your write scope, what is off-limits, and the checks that decide whether you passed.",
      "",
      "Work only inside your write scope. Other associates own everything else. Editing their files is the failure this system prevents.",
      "",
      "Do not read other associates' briefs. Yours is the whole of your job.",
      "",
      "Before you call yourself done:",
      "- inspect your own diff and changed files;",
      "- run every blocking check yourself, not just the fastest one;",
      "- read each check's real output, not just its exit code;",
      "- confirm your files satisfy `doneWhen`;",
      "- do not weaken, delete or bypass any check to make it pass.",
      "",
      "Only after all of that passes, call Cubicore's plan_mark tool with your own contract id and state done.",
      "",
      "If a check fails, decide: is the code wrong or the check wrong? Fixing code is the default.",
      "",
      "A check that contradicts the brief, or cannot be satisfied with the objective, is a defect in the check. Report which check, why, and leave the code correct. Do NOT bend the behaviour to satisfy it.",
      "",
      "Never remove or weaken a check. Never delete a test to make one pass. Never change specified behaviour -- an edge case the brief did not mention -- to make a check pass.",
      "",
      "If the brief is ambiguous, say so rather than guessing.",
      "",
      "MCP servers are optional. Use them only when genuinely blocked, not as a shortcut.",
    ].join("\n"),
  };
}

/** The filename an associate reads. Zero-padded so they sort in dispatch order. */
export function briefPath(index: number, contractId: string): string {
  const safe = contractId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${BRIEF_DIR}/${String(index + 1).padStart(2, "0")}-${safe}.md`;
}

export interface BriefOptions {
  /** What kind of project this is, as the Main agent described it. */
  projectKind?: string;
  /** Neighbouring contracts, so the associate knows what it must not duplicate. */
  siblings?: { id: string; writes: string[] }[];
}

/**
 * One associate's brief, as a standalone document.
 *
 * Standalone because the associate should never have to assemble its own
 * instructions from a shared file, and should never have reason to read
 * another associate's scope.
 */
export function renderBrief(
  contract: Contract,
  index: number,
  total: number,
  options: BriefOptions = {},
): string {
  const lines = [
    `# Brief ${index + 1} of ${total}: ${contract.id}`,
    `You own this. Do not read or edit any other associate's brief.`,
    `No placeholder code, no dead code, no bypassing checks. Production behavior, not sketch.`,
    ``,
    `## Objective`,
    ``,
    contract.objective,
    ``,
    `## Writes (only these)`,
    ``,
    ...(contract.writes.length
      ? contract.writes.map((w) => `- \`${w}\``)
      : ["*(none — report, not a diff)*"]),
    ``,
  ];

  if (contract.forbidden.length > 0) {
    const offLimits = contract.forbidden.filter((f) => looksLikePath(f));
    const constraints = contract.forbidden.filter((f) => !looksLikePath(f));
    if (offLimits.length) {
      lines.push(`## Off-limits (don't touch)`, ``, ...offLimits.map((f) => `- \`${f}\``), ``);
    }
    if (constraints.length) {
      lines.push(`## Constraints`, ``, ...constraints.map((f) => `- ${f}`), ``);
    }
  }

  // A constraint that names a file this contract owns is a rule about how to write it,
  // not a prohibition on touching it. Say so or the brief contradicts itself.
  const selfNamed = contract.forbidden.filter((f) =>
    contract.writes.some((w) => f.includes(w)),
  );
  if (selfNamed.length > 0) {
    lines.push(
      `One forbidden entry names a file you are writing — read it as a rule about how, not a prohibition on touching.`,
      ``,
    );
  }

  if (contract.reads.length > 0) {
    lines.push(`## Reads`, ``, ...contract.reads.map((r) => `- \`${r}\``), ``);
  }

  lines.push(
    `## Deliverable: ${contract.deliverable}. Done when: ${contract.doneWhen}`,
    ``,
  );

  const blocking = contract.checks.filter((k) => k.gating === "blocking");
  const advisory = contract.checks.filter((k) => k.gating !== "blocking");

  if (blocking.length > 0) {
    lines.push(`## Blocking — each must pass`, ``);
    for (const check of blocking) {
      lines.push("```", check.command, "```", `_${check.expectation}_`, "");
    }
  }
  if (advisory.length > 0) {
    lines.push(`## Advisory (optional)`, ``, ...advisory.map((k) => `- \`${k.command}\` — ${k.expectation}`), ``);
  }
  if (blocking.length === 0 && contract.deliverable === "diff") {
    lines.push(
      `No blocking checks were supplied — a diff with nothing that can fail is not verifiable. Say so rather than claiming success.`,
      ``,
    );
  }

  if (options.projectKind) {
    lines.push(`## Context`, ``, `Project kind: ${options.projectKind}`, ``);
  }

  const siblings = (options.siblings ?? []).filter((s) => s.id !== contract.id);
  if (siblings.length > 0) {
    lines.push(`## Siblings (not yours)`, ``, ...siblings.map((s) => `- ${s.id}`), ``);
  }

  lines.push(
    `## Completion`,
    `1. Run every blocking check. Read the real output.`,
    `2. Satisfy the task's doneWhen condition with running evidence.`,
    `3. Do not weaken any check.`,
    `4. Call \`plan_mark\` (contractId: "${contract.id}") with state \`done\`.`,
    `5. If a blocking check truly cannot pass, call \`plan_mark\` with state \`failed\` and name the check.`,
    ``,
    `## Report`,
    `One paragraph — what you changed, and each check's exact result.`,
    `If a check is wrong, name it and why — worth more than a green gate made of bent checks.`,
    ``,
  );

  return lines.join("\n");
}

/** Index document: who exists, what they own, and where their brief is. */
export function renderManifest(plan: Plan, options: BriefOptions = {}): string {
  return [
    `# Cubicore associates`,
    ``,
    `${plan.contracts.length} associate(s)${options.projectKind ? ` for a ${options.projectKind}` : ""}. Each brief at \`${BRIEF_DIR}/\`.`,
    ``,
    `| # | Associate | Deliverable | Write scope | Brief |`,
    `|---|---|---|---|---|`,
    ...plan.contracts.map(
      (c, i) =>
        `| ${i + 1} | ${c.id} | ${c.deliverable} | ` +
        `${c.writes.map((w) => `\`${w}\``).join(", ") || "—"} | \`${briefPath(i, c.id)}\` |`,
    ),
    ``,
  ].join("\n");
}

export function briefs(plan: Plan, options: BriefOptions = {}): { path: string; content: string }[] {
  const out = [
    { path: `${BRIEF_DIR}/README.md`, content: renderManifest(plan, options) },
  ];

  plan.contracts.forEach((contract, index) => {
    out.push({
      path: briefPath(index, contract.id),
      content: renderBrief(contract, index, plan.contracts.length, {
        projectKind: options.projectKind,
        siblings: plan.contracts.map((c) => ({ id: c.id, writes: c.writes })),
      }),
    });
  });

  return out;
}
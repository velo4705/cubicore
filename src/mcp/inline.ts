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
    prompt: [
      "You are a Cubicore associate. You are given one brief and nothing else.",
      "",
      "Read your brief. It names your write scope, what is off-limits, and the checks that",
      "decide whether you passed.",
      "",
      "Work only inside the files you were given. Files outside that set belong to other",
      "associates working at the same time; editing them is the single failure this system",
      "exists to prevent.",
      "",
      "Do not read other associates' briefs. Your own is the whole of your job.",
      "",
      "Every check you were given is blocking and must pass before you report done.",
      "",
      "If one fails, decide first whether the CODE or the CHECK is wrong. Fixing the code is",
      "the default, but it is not the only answer:",
      "",
      "A check that contradicts the brief, or that cannot be satisfied together with the",
      "objective, is a defect in the check. Do NOT bend the behaviour to satisfy it. Report",
      "which check, why it is unsatisfiable, and leave the code correct. An associate that",
      "changes working behaviour to satisfy a broken assertion has caused a real regression",
      "while making the gate green.",
      "",
      "Never remove or weaken a check. Never delete a test to make one pass. Never change",
      "specified behaviour -- an edge case the brief did not mention -- to make a check pass.",
      "",
      "If the brief is ambiguous, say so rather than guessing. A wrong guess surfaces later",
      "as a gate failure, having already cost the tokens.",
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
    "",
    `You are one of ${total} associates working in parallel. You own this piece and nothing else.`,
    "",
    "Do not read another associate's brief. Yours is the whole of your job.",
    "",
    "## Your objective",
    "",
    contract.objective,
    "",
    "## Your write scope — edit nothing outside this",
    "",
    ...(contract.writes.length
      ? contract.writes.map((w) => `- \`${w}\``)
      : ["*(none — you produce a report, not a diff)*"]),
    "",
  ];

  // The forbidden list mixes globs with prose, and rendering every entry as a
  // path made a brief contradict itself: an entry that merely mentioned a
  // file this contract owns was presented as "other associates own these",
  // and the associate had to decide which half to believe. Paths are listed
  // as off-limits; prose is listed as the constraint it actually is.
  const offLimits = contract.forbidden.filter((f) => looksLikePath(f));
  const constraints = contract.forbidden.filter((f) => !looksLikePath(f));

  if (offLimits.length > 0) {
    lines.push(
      "## Explicitly off-limits",
      "",
      "Other associates own these. Touching them will collide.",
      "",
      ...offLimits.map((f) => `- \`${f}\``),
      "",
    );
  }

  if (constraints.length > 0) {
    lines.push(
      "## Constraints",
      "",
      "These are rules, not paths. They bind you even where they name a file you own.",
      "",
      ...constraints.map((f) => `- ${f}`),
      "",
    );
  }

  // A constraint that names a file this contract owns is not a prohibition on
  // it. Say so, or the brief contradicts itself and the associate has to guess
  // which half is true.
  const selfNamed = contract.forbidden.filter((f) =>
    contract.writes.some((w) => f.includes(w)),
  );
  if (selfNamed.length > 0) {
    lines.push(
      "## Note on your own files",
      "",
      "A constraint above mentions a file you are writing. Read it as a rule about",
      "how to write it, not as a prohibition on touching it -- you own that file.",
      "",
      ...selfNamed.map((f) => `- ${f}`),
      "",
    );
  }

  if (contract.reads.length > 0) {
    lines.push("## You may read", "", ...contract.reads.map((r) => `- \`${r}\``), "");
  }

  lines.push(
    "## What you deliver",
    "",
    `- **Kind:** ${contract.deliverable}`,
    `- **Done when:** ${contract.doneWhen}`,
    "",
  );

  const blocking = contract.checks.filter((k) => k.gating === "blocking");
  const advisory = contract.checks.filter((k) => k.gating !== "blocking");

  if (blocking.length > 0) {
    lines.push("## Blocking checks — every one must pass", "");
    for (const check of blocking) {
      lines.push("```", check.command, "```", `_${check.expectation}_`, "");
    }
  }
  if (advisory.length > 0) {
    lines.push(
      "## Advisory — run if cheap, do not chase",
      "",
      ...advisory.map((k) => `- \`${k.command}\` — ${k.expectation}`),
      "",
    );
  }
  if (blocking.length === 0 && contract.deliverable === "diff") {
    lines.push(
      "## Blocking checks",
      "",
      "_None were supplied. A diff with nothing that can fail is not verifiable — if you",
      "cannot find a command that proves this work, say so rather than claiming success._",
      "",
    );
  }

  if (options.projectKind) {
    lines.push("## Context", "", `- **Project kind:** ${options.projectKind}`, "");
  }

  const siblings = (options.siblings ?? []).filter((s) => s.id !== contract.id);
  if (siblings.length > 0) {
    lines.push(
      "## Who else is working",
      "",
      "_Listed so you know what is not yours. Do not read their briefs and do not edit them._",
      "",
      ...siblings.map((s) => `- **${s.id}** — ${s.writes.join(", ") || "(report)"}`),
      "",
    );
  }

  lines.push(
    "## Report back",
    "",
    "One paragraph: what you changed and the exact result of each check. Do not paste whole",
    "files — the diff is the record, and the founder reads the contract checks, not your prose.",
    "",
    "**If a check is wrong**, say so explicitly and name it:",
    "",
    "- which check, and the exact command",
    "- why it cannot pass given the objective, or what it contradicts",
    "- what you left alone instead",
    "",
    "That report is worth more than a green gate. A check bent to fit wrong code is a",
    "regression that reported itself as a pass.",
    "",
  );

  return lines.join("\n");
}

/** Index document: who exists, what they own, and where their brief is. */
export function renderManifest(plan: Plan, options: BriefOptions = {}): string {
  return [
    `# Cubicore associates`,
    "",
    `${plan.contracts.length} associate(s)${options.projectKind ? ` for a ${options.projectKind}` : ""}. ` +
      `Each has one brief in \`${BRIEF_DIR}/\`.`,
    "",
    "| # | Associate | Deliverable | Write scope | Brief |",
    "|---|---|---|---|---|",
    ...plan.contracts.map(
      (c, i) =>
        `| ${i + 1} | ${c.id} | ${c.deliverable} | ` +
        `${c.writes.map((w) => `\`${w}\``).join(", ") || "—"} | \`${briefPath(i, c.id)}\` |`,
    ),
    "",
    `Dispatch each to the \`${ASSOCIATE_AGENT_ID}\` sub-agent, in parallel.`,
    `Collect every report separately — each contract is judged on its own`,
    `checks, and a merged report hides which one failed.`,
    "",
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
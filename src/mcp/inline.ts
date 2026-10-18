import { PLAN_SCHEMA_JSON } from "../contracts/schema";
import type { Plan } from "../contracts/types";

/**
 * Inline dispatch: the host's own sub-agent mechanism.
 *
 * A host that supports inline sub-tasks renders each associate as a step in
 * the conversation, which is the difference between watching four workers and
 * watching one opaque tool call for six minutes.
 *
 * Cubicore cannot *invoke* a host tool -- an MCP server offers tools, it does
 * not call the client's. So the host dispatches. What Cubicore supplies is
 * everything else: the validated split, the armed sub-agent, and the gate that
 * judges what comes back. Ownership of the N calls is the host's; ownership of
 * the contract is Cubicore's.
 *
 * The session path stays available because 5 of 9 surveyed agents have no
 * inline sub-tasks at all, and there Cubicore dispatches itself.
 */

export const ASSOCIATE_AGENT_ID = "cubicore-associate";

/**
 * The sub-agent every inline dispatch runs as.
 *
 * Permissions are deliberately permissive and enforcement is post-hoc: a
 * statically registered agent cannot be given per-contract globs, because the
 * config hook runs at startup and contracts are chosen later. So the scope
 * gate is what actually catches a contract that wandered outside its write
 * set, and it runs on the returned artifact rather than on a promise.
 *
 * If opencode ever accepts permissions per task call, this should move.
 */
export function associateAgentConfig(): Record<string, unknown> {
  return {
    description:
      "A Cubicore associate. Executes exactly one contract: a bounded write scope, a " +
      "deliverable, and a set of checks that decide whether it passed. Never widens its " +
      "own scope and never edits outside the files it was given.",
    mode: "subagent",
    temperature: 0,
    prompt: [
      "You are a Cubicore associate. You are given one contract and nothing else.",
      "",
      "Work only inside the `writes` globs you were given. Files outside that set belong to",
      "other associates working in parallel; editing them is the single failure this system",
      "exists to prevent.",
      "",
      "Every check you were given is blocking and must pass before you report done. If a",
      "check fails, fix the cause rather than the check. Never remove or weaken a check, and",
      "never delete a test to make one pass.",
      "",
      "If the contract is ambiguous, say so rather than guessing. A wrong guess surfaces",
      "later as a gate failure, having already cost the tokens.",
    ].join("\n"),
  };
}

/** One contract rendered as the instruction the host passes to its sub-agent tool. */
export function taskInstruction(contract: Plan["contracts"][number], index: number): string {
  const lines = [
    `# Contract ${index + 1} of a Cubicore run: ${contract.id}`,
    "",
    `**Objective**`,
    contract.objective,
    "",
    `**Your write scope — nothing else**`,
    ...contract.writes.map((w) => `- ${w}`),
    "",
    ...(contract.forbidden.length
      ? [`**Explicitly off-limits**`, ...contract.forbidden.map((f) => `- ${f}`), ""]
      : []),
    ...(contract.reads.length
      ? [`**You may read**`, ...contract.reads.map((r) => `- ${r}`), ""]
      : []),
    `**Deliverable:** ${contract.deliverable}`,
    "",
    `**Done when**`,
    contract.doneWhen,
    "",
  ];

  if (contract.checks.length > 0) {
    lines.push(`**Blocking checks — all must pass**`, "");
    for (const check of contract.checks) {
      if (check.gating !== "blocking") continue;
      lines.push(`\`\`\``, check.command, `\`\`\``, `_${check.expectation}_`, "");
    }
    const advisory = contract.checks.filter((c) => c.gating !== "blocking");
    if (advisory.length > 0) {
      lines.push(`**Advisory — run if cheap, do not chase**`, "");
      for (const check of advisory) lines.push(`\`${check.command}\` — ${check.expectation}`);
      lines.push("");
    }
  }

  lines.push(
    `**Report back** with a one-paragraph summary of what you changed and the exact result`,
    `of each check. Do not paste whole files -- the diff is the record.`,
  );

  return lines.join("\n");
}

/**
 * The blueprint: one ready-to-dispatch instruction per associate.
 *
 * Emitted as data rather than acted on, because the host owns the dispatch.
 * A host without inline sub-tasks ignores this and the session path runs
 * instead.
 */
export function dispatchBlueprint(plan: Plan): string {
  return [
    `# Cubicore dispatch blueprint`,
    ``,
    `Topology: ${plan.topology}. ${plan.contracts.length} associate(s).`,
    ``,
    `Dispatch each block below to the \`${ASSOCIATE_AGENT_ID}\` sub-agent. They are independent,`,
    `so they may run in parallel. Do not merge their reports -- return them separately so each`,
    `contract's checks can be judged on its own.`,
    ``,
    ...plan.contracts.map((c, i) => taskInstruction(c, i)),
  ].join("\n");
}

export const BLUEPRINT_SCHEMA = PLAN_SCHEMA_JSON;
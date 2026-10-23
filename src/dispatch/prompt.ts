import type { Check, Contract } from "../contracts/types";
import { effectiveMatrix } from "../validate/matrix";

/**
 * What a worker actually receives (D1).
 *
 * A worker never gets a prose prompt; it gets this rendering of its contract.
 * Every element here is a constraint the worker cannot talk its way past, which
 * is why the forbidden list is stated as a prohibition rather than left to the
 * permission rules alone — globs are enforcement, prose is comprehension.
 *
 * Pure by design: no I/O, no SDK. If a worker misbehaves, this function is the
 * first suspect and it must be inspectable in isolation.
 */

export interface PromptOptions {
  baseline?: readonly Check[];
  /** Ceiling the worker is told about, in tokens. */
  tokenBudget?: number;
}

export function renderPrompt(contract: Contract, options: PromptOptions = {}): string {
  const matrix = effectiveMatrix(options.baseline ?? [], contract.checks);
  const blocking = matrix.filter(
    (check) => check.gating === "blocking" && check.convergent,
  );

  const sections: string[] = [];

  sections.push(`# Objective\n\n${contract.objective}`);

  if (contract.tools && contract.tools.length > 0) {
    const tools = contract.tools;
    sections.push(
      [
        "# MCP servers and tools you may use",
        "",
        "The host has these MCP servers registered. You may use any of them:",
        "",
        ...tools.map((tool) => `- \`${tool}\``),
        "",
      ].join("\n"),
    );
  }

  sections.push(
    [
      "# You may write to these paths, and no others",
      "",
      ...(contract.writes.length > 0 ? contract.writes.map((path) => `- ${path}`) : ["- (nothing — you are read-only)"]),
    ].join("\n"),
  );

  if (contract.forbidden.length > 0) {
    sections.push(
      [
        "# Never touch these paths",
        "",
        ...contract.forbidden.map((path) => `- ${path}`),
      ].join("\n"),
    );
  }

  if (contract.reads.length > 0) {
    sections.push(
      ["# Read these for context", "", ...contract.reads.map((path) => `- ${path}`)].join("\n"),
    );
  }

  sections.push(`# Your work is done when\n\n${contract.doneWhen}`);

  if (blocking.length > 0) {
    sections.push(
      [
        "# Checks you must satisfy",
        "",
        ...blocking.map((check, index) => {
          const lines = [
            `${index + 1}. \`${check.command}\` must pass. Expected: ${check.expectation}`,
          ];
          // Stating the consequence is what stops a worker declaring victory
          // while a check is red.
          lines.push("   A failing blocking check gets you exactly one revision attempt.");
          return lines.join("\n");
        }),
      ].join("\n"),
    );
  }

  const tokenBudget = options.tokenBudget ?? contract.budget.tokens;
  sections.push(
    [
      "# Budget",
      "",
      `- At most ${contract.budget.toolCalls} tool calls`,
      `- At most ${Math.round(tokenBudget / 1000)}k tokens`,
      `- At most ${Math.round(contract.budget.wallMs / 1000)}s of wall time`,
      "",
      "Exceeding these ends your run. Partial work is kept only if the checks already pass.",
    ].join("\n"),
  );

  sections.push(deliverableInstruction(contract.deliverable));

  return sections.join("\n\n");
}

/**
 * The return contract. Keeps the aggregator reading artifacts instead of
 * transcripts (D7): a worker told to return prose produces prose, and the
 * aggregator then has to parse an argument rather than read a diff.
 */
function deliverableInstruction(deliverable: Contract["deliverable"]): string {
  switch (deliverable) {
    case "diff":
      return "# Output\n\nReturn only the unified diff of your changes. No explanation, no summary.";
    case "report":
      return "# Output\n\nReturn only your findings as JSON matching the contract schema. No explanation.";
    case "data":
      return "# Output\n\nReturn only the JSON payload matching the contract schema. No explanation.";
  }
}

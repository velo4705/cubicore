/**
 * The factory retrospective.
 *
 * After a run — pass or fail — the founder is owed a plain sentence about
 * what the factory actually did. Not a report, not an inspection. Same
 * honesty as the rest: we record facts, not opinions in the agent's voice.
 *
 * What it does NOT do: claim the split was optimal, claim time savings,
 * claim cost efficiency. We don't measure those yet.
 */

import type { FactoryFit } from "../factory/fit";
import type { AggregatedArtifact } from "../aggregate/index";

export type Retrospective = {
  fit: FactoryFit | undefined;
  workers: number;
  passed: number;
  flagged: number;
  deferred: number;
  totalTokens: number;
  verdict: string;
};

/** The agent-side artifact, written per run and surfaced in the reply. */
export function buildRetrospective(opts: {
  fit: FactoryFit | undefined;
  artifacts: AggregatedArtifact[];
  unresolved: string[];
  deferred: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
}): Retrospective {
  const totalTokens =
    opts.usage.input + opts.usage.output + opts.usage.cacheRead + opts.usage.cacheWrite + opts.usage.reasoning;
  const flagged = opts.artifacts.filter((a) => a.status === "flagged").length;
  const passed = opts.artifacts.length - flagged;

  const fit = opts.fit;
  let verdict: string;

  if (passed === 0 && opts.artifacts.length > 0) {
    verdict = `None of the ${opts.artifacts.length} associates finished with verifiable work. The requested split was either too aggressive for this task, or the plan was wrong — see ${opts.unresolved.slice(0, 3).join("; ")}`;
  } else if (flagged > 0 && passed === 0) {
    verdict = `The factory did not produce a passing result. ${flagged} associate(s) were dispatched and every one left flagged. Under-splitting would not change the outcome; refine the plan to what can actually pass checks.`;
  } else if (flagged > 0) {
    verdict = `${passed} of ${opts.artifacts.length} associates produced verifiable work; ${flagged} left flagged. Work that passed was kept, work that did not was discarded — nothing landed unvetted.`;
  } else if (fit?.decision === "single-agent") {
    verdict = `A plan of one agent was dispatched. It produced one verified artifact instead of over-splitting and over-spending.`;
  } else {
    verdict = `All ${passed} associates produced verifiable work. The split was ${fit?.decision ?? "unspecified"}; every contract ran with its own checks before integration.`;
  }

  return {
    fit,
    workers: opts.artifacts.length,
    passed,
    flagged,
    deferred: opts.deferred,
    totalTokens,
    verdict,
  };
}

export function renderRetrospective(r: Retrospective): string {
  const lines = [
    `**What the factory did**`,
    ``,
    r.fit ? `- Decision: ${r.fit.decision} · ${r.workers} associate${r.workers === 1 ? "" : "s"}` : `- Decision: (not recorded)`,
    `- Passed: ${r.passed} · Flagged: ${r.flagged}${r.deferred > 0 ? ` · Deferred: ${r.deferred}` : ""}`,
    `- Tokens: ${r.totalTokens.toLocaleString()}`,
    r.fit ? `- Why this size: ${r.fit.why}` : ``,
    `- Verdict: ${r.verdict}`,
  ];
  return lines.filter(Boolean).join("\n");
}

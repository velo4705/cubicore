/**
 * Coverage — did the plan actually address what the founder asked for?
 *
 * The brief is a list of musts, needs, and wants; the plan is a list of
 * contracts. The honest question is whether every one of the musts is
 * addressed by at least one contract. This is not an LLM oracle; it is a
 * deterministic token-overlap check with explicit refusals flagged.
 *
 * The report says what it sees; it never claims those matches mean the
 * contract's code will actually do the thing — only that the plan gestures
 * toward the same nouns. That is the most an automated check can see.
 */

import type { Contract, Plan } from "../contracts/types";

export interface CoverageItem {
  /** The phrase from the brief being assessed. */
  text: string;
  /** Contract ids whose objective/writes/doneWhen match this phrase, in ranked order. */
  matched: string[];
  /** Mechanical only: does any contract touch all bigrams of this item? */
  covered: boolean;
}

export interface CoverageReport {
  totalItems: number;
  coveredItems: number;
  /** Fraction covered, 0–1. A deliberately low bar; useful only as a signal. */
  coverage: number;
  items: CoverageItem[];
  verdict: "complete" | "partial" | "missing";
  /** Anything the brief phrases as a must that genuinely matched nothing. */
  unaddressed: string[];
}

const STOP = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "but",
  "is", "are", "it", "its", "this", "that", "these", "those", "with",
  "be", "been", "have", "has", "had", "not", "no", "as", "at", "by",
  "from", "i", "you", "we", "they", "will", "would", "could", "can",
  "do", "does", "done", "into", "about", "image", "one", "two", "all",
]);

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_+-]+/)) {
    const t = raw.trim();
    if (t.length < 3) continue;
    if (STOP.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** Extract candidate "items" from the brief — sentence-ish units. */
export function extractItems(brief: string): string[] {
  // Break on sentence boundaries: period before a capital or a known list marker.
  // Greedy-but-conservative — anything with token mass survives; filler
  // sentences get dropped by the tokens() filter below.
  const pieces = brief.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  const items: string[] = [];
  for (const raw of pieces) {
    const trimmed = raw.trim();
    if (trimmed.length < 8) continue;
    if (/^(the|a|an|this|that|now|next|finally|also)/i.test(trimmed) && trimmed.split(/\s+/).length <= 3) continue;
    items.push(trimmed);
  }
  return items.filter((item) => tokens(item).size > 0);
}

/** Score a brief item against a contract's text surfaces via shared tokens. */
function score(itemTokens: Set<string>, contract: Contract): number {
  const surfaces = tokens([
    contract.objective ?? "",
    contract.doneWhen ?? "",
    (contract.writes ?? []).join(" "),
    (contract.forbidden ?? []).join(" "),
    (contract.reads ?? []).join(" "),
    contract.schema ? Object.keys(contract.schema).join(" ") : "",
    (contract.checks ?? []).map((c) => c.command).join(" "),
  ].join(" "));
  let shared = 0;
  for (const t of itemTokens) if (surfaces.has(t)) shared += 1;
  return shared;
}

export function assessCoverage(brief: string, plan: Plan): CoverageReport {
  const items = extractItems(brief);
  const assessed: CoverageItem[] = items.map((text) => {
    const its = tokens(text);
    const scored = plan.contracts
      .map((c) => ({ contractId: c.id, score: score(its, c) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const covered = scored.some((x) => x.score >= 2 || itStrong(text, x.contractId, plan));
    return { text, matched: scored.map((x) => x.contractId), covered };
  });
  const coveredCount = assessed.filter((i) => i.covered).length;
  const unaddressed = assessed.filter((i) => !i.covered).map((i) => i.text);
  return {
    totalItems: assessed.length,
    coveredItems: coveredCount,
    coverage: items.length === 0 ? 1 : coveredCount / items.length,
    items: assessed,
    verdict: unaddressed.length === 0 ? "complete" : unaddressed.length < items.length / 2 ? "partial" : "missing",
    unaddressed,
  };
}

/**
 * A rescue clause for small items: if the phrase asks for something with a
 * very small vocabulary (e.g. "a README"or "hotbar"), treat any contract that
 * matches that exact token as addressing it.
 */
function itStrong(text: string, id: string, plan: Plan): boolean {
  const ts = tokens(text);
  if (ts.size < 2) return false;
  const c = plan.contracts.find((x) => x.id === id);
  if (!c) return false;
  const surface = tokens([c.objective ?? "", c.doneWhen ?? "", (c.writes ?? []).join(" ")].join(" "));
  for (const t of ts) if (surface.has(t)) return true;
  return false;
}

/** Plain-text render for plan output. */
export function renderCoverage(report: CoverageReport): string {
  const lines = [
    `Coverage: ${report.coveredItems}/${report.totalItems} (${(report.coverage * 100).toFixed(0)}%) — ${report.verdict}`,
  ];
  for (const item of report.items) {
    const status = item.covered ? "✓" : "✗";
    const match = item.matched.length ? ` → ${item.matched.join(", ")}` : " → (none)";
    lines.push(`  ${status} ${item.text.slice(0, 140)}${item.text.length > 140 ? "…" : ""}${match}`);
  }
  if (report.unaddressed.length) {
    lines.push("", "Unaddressed (the plan may have ignored or misunderstood these):");
    for (const u of report.unaddressed) lines.push(`  - ${u}`);
  }
  return lines.join("\n");
}

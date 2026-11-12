/**
 * Contract escalations — the record that a contract could not be verified
 * on this host, and what the founder must do about it.
 *
 * A check that could not *run* (missing tool, offline dependency, permission
 * denied) is not a check that failed. The distinction exists everywhere else
 * in Cubicore; this is the place it is persisted so it survives the run and
 * shows up forever, rather than hiding behind an opaque green or red.
 *
 * Semantics:
 * - `.cubicore-escalations.json` is a *snapshot*: one file per project,
 *   rewritten on every verify. Empty state deletes it — the absence of the
 *   file is the absence of escalations, not "no information".
 * - `attempts` counts how many verify cycles have re-found the same
 *   contract+check blocked. It is the honest version of "bounded retries":
 *   Cubicore will not auto-retry forever; each verify tells the truth about
 *   whether the founder fixed it.
 * - The ledger carries the same escalation list so the history is auditable
 *   via .cubicore-factory-history.jsonl too.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface Escalation {
  contractId: string;
  checkId: string;
  /** What could not run — the digest of the failure, not an opinion. */
  reason: string;
  /** Exactly one next move for the founder — never "try again". */
  nextAction: string;
  recordedAt: number;
  /** How many verify cycles have found this contract+check blocked. */
  attempts: number;
}

const FILE = ".cubicore-escalations.json";
const VERSION = 1;
/** One next move — Cubicore will not auto-retry unverified work. */
const NEXT_ACTION =
  "install the missing tool / restore the dependency, then /cubicore:continue — Cubicore will not silently re-run unverified work";

export function readEscalations(directory: string): Escalation[] {
  try {
    const parsed = JSON.parse(readFileSync(`${directory}/${FILE}`, "utf8")) as {
      escalations?: unknown;
    };
    return Array.isArray(parsed.escalations) ? (parsed.escalations as Escalation[]) : [];
  } catch {
    return [];
  }
}

export function writeEscalations(directory: string, escalations: Escalation[]): void {
  writeFileSync(
    `${directory}/${FILE}`,
    JSON.stringify({ version: VERSION, escalations, recordedAt: Date.now() }, null, 2),
  );
}

export function clearEscalations(directory: string): void {
  try {
    unlinkSync(`${directory}/${FILE}`);
  } catch {
    // No file on disk is the desired end state — nothing escalated.
  }
}

/**
 * Merge freshly-verified blocked contracts into the snapshot. Identifies the
 * same contract+check across cycles and carries the attempts counter forward
 * so each verify can say "still blocked, 2nd cycle".
 */
export function recordEscalations(
  directory: string,
  fresh: readonly { contractId: string; checkId: string; reason: string }[],
): Escalation[] {
  const previous = new Map(
    readEscalations(directory).map((e) => [`${e.contractId}::${e.checkId}`, e] as const),
  );
  const merged = fresh.map(({ contractId, checkId, reason }) => {
    const prev = previous.get(`${contractId}::${checkId}`);
    return {
      contractId,
      checkId,
      reason: reason.slice(0, 200),
      nextAction: NEXT_ACTION,
      recordedAt: Date.now(),
      attempts: (prev?.attempts ?? 0) + 1,
    };
  });
  writeEscalations(directory, merged);
  return merged;
}

/** One line for status surfaces; null when nothing is escalated. */
export function escalatedLine(directory: string): string | null {
  const list = readEscalations(directory);
  if (list.length === 0) return null;
  return `Escalated (${list.length}): ${list
    .map((e) => `${e.contractId} — ${e.nextAction} (cycle ${e.attempts})`)
    .join(" · ")}`;
}

/** Compact form for the ledger / history archive. */
export function escalatedLedger(directory: string): Escalation[] {
  return readEscalations(directory);
}


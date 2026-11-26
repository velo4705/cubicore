/**
 * One append-only place for plan-and-run context across runs.
 *
 * The old shape scattered context over CUBICORE_PLAN*.md, CONTEXT_N.md,
 * .cubicore-factory-history.jsonl and the run files. This archive records the
 * join: which plan digest ran, in which run, under which mode, and what the
 * verdict was. It stores a digest, never the plan body, and no credentials.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { Plan, PlanMode } from "../contracts/types";

const ARCHIVE_FILE = ".cubicore-archive.jsonl";

export interface ArchiveEntry {
  v: 1;
  at: string;
  runId: string;
  planDigest: string;
  mode: PlanMode;
  topology: Plan["topology"];
  contracts: number;
  state: "done" | "failed" | "cancelled" | "paused";
  verdict: string;
}

export function planDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function appendArchive(directory: string, entry: ArchiveEntry): void {
  try {
    appendFileSync(join(directory, ARCHIVE_FILE), `${JSON.stringify(entry)}\n`);
  } catch {
    // An archive is an audit convenience, never a gate. Like the ledger, a
    // filesystem failure must not turn a finished run into a failed one.
  }
}

export function readArchive(directory: string): ArchiveEntry[] {
  const path = join(directory, ARCHIVE_FILE);
  if (!existsSync(path)) return [];
  const out: ArchiveEntry[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as ArchiveEntry;
        if (entry.v === 1 && typeof entry.runId === "string") out.push(entry);
      } catch {
        // A torn last line from an interrupted append is ignored, not fatal.
      }
    }
  } catch {
    return [];
  }
  return out;
}

export function renderArchive(entries: readonly ArchiveEntry[]): string[] {
  if (entries.length === 0) return ["No runs archived in this directory yet."];
  return entries.map((e) =>
    `${e.at}  ${e.state.padEnd(9)}  ${e.mode.padEnd(4)}  ${e.contracts} contract(s)  ${e.planDigest}  ${e.verdict.slice(0, 120)}`,
  );
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Plan } from "../contracts/types";

/**
 * Runs, with per-contract progress, persisted to disk.
 *
 * They were in memory and process-local, which made three of the commands
 * impossible: a cancelled run vanished on restart, a paused run could not be
 * resumed, and a status poll could not say which contracts had finished.
 *
 * Persisted state also means the founder can close opencode, come back
 * tomorrow, and ask what happened.
 */

export type ContractState = "pending" | "running" | "done" | "failed" | "skipped";

export interface RunProgress {
  contractId: string;
  state: ContractState;
  detail?: string;
}

export type RunState = "running" | "paused" | "done" | "failed" | "cancelled";

export interface Run {
  id: string;
  startedAt: number;
  finishedAt?: number;
  plan: Plan;
  state: RunState;
  summary?: string;
  error?: string;
  /** Per-contract progress, in dispatch order. */
  progress: RunProgress[];
  /** The directory the run is working in, for git operations. */
  directory: string;
  /** The baseline commit, so an undo knows what to go back to. */
  baseline?: string;
  /** Set when the run was cancelled, so the reason survives. */
  cancelledBecause?: string;
}

const STATE_DIR = ".cubicore";

function statePath(directory: string): string {
  return join(directory, STATE_DIR, "runs.json");
}

/** All runs for a directory, newest first. */
export function loadRuns(directory: string): Run[] {
  const path = statePath(directory);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Run[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRuns(directory: string, runs: Run[]): void {
  const path = statePath(directory);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(runs, null, 2)}\n`);
}

export function startRun(plan: Plan, directory: string, baseline?: string): Run {
  const run: Run = {
    id: `run-${Date.now().toString(36)}`,
    startedAt: Date.now(),
    plan,
    state: "running",
    directory,
    baseline,
    progress: plan.contracts.map((c) => ({ contractId: c.id, state: "pending" as ContractState })),
  };
  const runs = loadRuns(directory).filter((r) => r.id !== run.id);
  runs.unshift(run);
  saveRuns(directory, runs);
  return run;
}

export function getRun(id: string, directory?: string): Run | undefined {
  if (directory) return loadRuns(directory).find((r) => r.id === id);
  // Without a directory, look in the current one.
  return loadRuns(process.cwd()).find((r) => r.id === id);
}

function update(run: Run, patch: Partial<Run>): Run {
  const next = { ...run, ...patch };
  const runs = loadRuns(next.directory).filter((r) => r.id !== next.id);
  runs.unshift(next);
  saveRuns(next.directory, runs);
  return next;
}

export function finishRun(id: string, directory: string, summary: string): void {
  const run = loadRuns(directory).find((r) => r.id === id);
  if (!run) return;
  update(run, { state: "done", summary, finishedAt: Date.now() });
}

export function failRun(id: string, directory: string, error: string): void {
  const run = loadRuns(directory).find((r) => r.id === id);
  if (!run) return;
  update(run, { state: "failed", error, finishedAt: Date.now() });
}

/**
 * Stop a run.
 *
 * The only thing that actually stops the spending is aborting the worker
 * sessions, and that is the host's job -- so this records the intent, and the
 * dispatch checks it between contracts and stages.
 */
export function cancelRun(id: string, directory: string, reason: string): Run | undefined {
  const run = loadRuns(directory).find((r) => r.id === id);
  if (!run) return undefined;
  return update(run, {
    state: "cancelled",
    cancelledBecause: reason,
    finishedAt: Date.now(),
    progress: run.progress.map((p) =>
      p.state === "pending" || p.state === "running"
        ? { ...p, state: "skipped" as ContractState, detail: "cancelled" }
        : p,
    ),
  });
}

/** Hold a run between contracts. The work in flight is not interrupted. */
export function pauseRun(id: string, directory: string): Run | undefined {
  const run = loadRuns(directory).find((r) => r.id === id);
  if (!run) return undefined;
  return update(run, { state: "paused" });
}

export function resumeRun(id: string, directory: string): Run | undefined {
  const run = loadRuns(directory).find((r) => r.id === id);
  if (!run) return undefined;
  return update(run, { state: "running" });
}

/** Is this run cancelled or paused? The dispatch checks it between stages. */
export function haltState(id: string, directory: string): "cancelled" | "paused" | null {
  const run = loadRuns(directory).find((r) => r.id === id);
  if (!run) return null;
  if (run.state === "cancelled") return "cancelled";
  if (run.state === "paused") return "paused";
  return null;
}

export function recordProgress(id: string, directory: string, contractId: string, state: ContractState, detail?: string): void {
  const run = loadRuns(directory).find((r) => r.id === id);
  if (!run) return;
  const progress = run.progress.map((p) =>
    p.contractId === contractId ? { ...p, state, detail: detail ?? p.detail } : p,
  );
  update(run, { progress });
}

/** Human-readable status, so a poll needs no parsing. */
export function describe(run: Run): string {
  const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
  const done = run.progress.filter((p) => p.state === "done").length;
  const failed = run.progress.filter((p) => p.state === "failed").length;
  const skipped = run.progress.filter((p) => p.state === "skipped").length;
  const counts = `${done} done, ${failed} failed, ${skipped} skipped`;

  if (run.state === "running") {
    return `run ${run.id}: running, ${run.plan.contracts.length} associates (${counts}), ${elapsed}s elapsed`;
  }
  if (run.state === "paused") {
    return `run ${run.id}: paused at ${counts}, ${elapsed}s elapsed. Resume it with the resume command.`;
  }
  if (run.state === "cancelled") {
    return `run ${run.id}: cancelled (${run.cancelledBecause ?? "no reason given"}) after ${elapsed}s, ${counts}.`;
  }
  if (run.state === "failed") {
    return `run ${run.id}: failed after ${elapsed}s — ${run.error}`;
  }
  return `run ${run.id}: done in ${elapsed}s (${counts})\n\n${run.summary ?? ""}`;
}

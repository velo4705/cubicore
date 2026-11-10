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

export type ContractState = "pending" | "running" | "done" | "blocked" | "failed" | "skipped";

export interface RunProgress {
  contractId: string;
  state: ContractState;
  detail?: string;
  /** Step-level progress: stepId -> state. Present when the contract declares steps. */
  steps?: Record<string, ContractState>;
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

/** Maximum number of run records to keep per directory. */
const MAX_RUNS = 50;

function findStatePath(startDir: string): string | null {
  let current = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(current, STATE_DIR, "runs.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function statePath(directory: string): string | null {
  return findStatePath(directory);
}

/** All runs for a directory, newest first. */
export function loadRuns(directory: string): Run[] {
  const path = statePath(directory);
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Run[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRuns(directory: string, runs: Run[]): void {
  const path = join(directory, STATE_DIR, "runs.json");
  mkdirSync(dirname(path), { recursive: true });

  // Prune old runs so the file doesn't grow without bound. Newest first.
  const kept = runs.slice(0, MAX_RUNS);
  writeFileSync(path, `${JSON.stringify(kept, null, 2)}\n`);
}

export function startRun(plan: Plan, directory: string, baseline?: string): Run {
  const run: Run = {
    id: `run-${Date.now().toString(36)}`,
    startedAt: Date.now(),
    plan,
    state: "running",
    directory,
    baseline,
    progress: plan.contracts.map((c) => ({
      contractId: c.id,
      state: "pending" as ContractState,
      ...(c.steps ? { steps: Object.fromEntries(c.steps.map((s) => [s.id, "pending" as ContractState])) } : {}),
    })),
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

/** Is this run cancelled or paused? The dispatch checks it between stages. */
export function haltState(id: string, directory: string): "cancelled" | "paused" | null {
  const run = loadRuns(directory).find((r) => r.id === id);
  if (!run) return null;
  if (run.state === "cancelled") return "cancelled";
  if (run.state === "paused") return "paused";
  return null;
}

export function recordProgress(
  id: string,
  directory: string,
  contractId: string,
  state: ContractState,
  detail?: string,
  stepId?: string,
): void {
  const run = loadRuns(directory).find((r) => r.id === id);
  if (!run) return;
  const progress = run.progress.map((p) => {
    if (p.contractId !== contractId) return p;
    const next = { ...p, state, detail: detail ?? p.detail };
    if (stepId && p.steps) {
      next.steps = { ...p.steps, [stepId]: state };
    }
    return next;
  });
  update(run, { progress });
}

/** Human-readable status, so a poll needs no parsing. */
/**
 * What the founder sees. One line for the run's own state, one line per
 * associate, one line for the factory's verdict. No transcripts — this is
 * the whole picture on one screen, and that is the point of it.
 */
/** Status line for /cubicore:status that includes the lifecycle stage. */
export function statusLine(run: Run): string {
  return describe(run);
}

export function describe(run: Run): string {
  const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
  const done = run.progress.filter((p) => p.state === "done").length;
  const blocked = run.progress.filter((p) => p.state === "blocked").length;
  const failed = run.progress.filter((p) => p.state === "failed").length;
  const skipped = run.progress.filter((p) => p.state === "skipped").length;
  const counts = `${done} done${blocked > 0 ? ` · ${blocked} blocked` : ""} · ${failed} failed · ${skipped} skipped`;

  const stage = run.state === "running"
    ? "dispatch"
    : run.state === "paused"
      ? "paused"
      : run.state === "cancelled"
        ? "cancelled"
        : run.state === "failed"
          ? "failed"
          : "done";

  const contractLines = run.plan.contracts.map((contract) => {
    const p = run.progress.find((entry) => entry.contractId === contract.id);
    const icon =
      p?.state === "done" ? "✅" :
      p?.state === "blocked" ? "⚠️" :
      p?.state === "failed" ? "❌" :
      p?.state === "skipped" ? "⏭️" :
      p?.state === "running" ? "🔄" : "⏳";
    const detail = p?.detail ?? (p?.state ?? "waiting");
    const head = `${icon} ${contract.id}`;
    const body = ` — ${detail}${contract.writes.length > 0 ? ` (writes: ${contract.writes.join(", ")})` : ""}`;
    return `${head}${body}`;
  });

  const lines = [
    `run ${run.id} · stage: ${stage} · elapsed ${elapsed}s`,
    `Associates: ${counts}`,
    ...contractLines,
  ];

  if (run.state === "paused") {
    lines.push("Next: /cubicore:continue resumes the run from where it stopped.");
  } else if (run.state === "running") {
    lines.push("Next: this run is still in flight; check again in a moment.");
  } else if (run.state === "failed") {
    lines.push(`Next: see the failure${run.error ? ` (${run.error})` : ""}. \`/cubicore:refine\` to narrow the plan or \`/cubicore:continue\` to resume.`);
  } else if (run.state === "cancelled") {
    lines.push("Next: the run stopped on purpose. \`/cubicore:continue\` resumes it.");
  } else if (run.summary) {
    lines.push(`Verdict:`, run.summary);
  }

  return lines.join("\n");
}

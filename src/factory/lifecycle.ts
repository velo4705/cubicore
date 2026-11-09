/**
 * Cubicore's factory lifecycle — explicit states, not emergent dispatch.
 *
 * The factory is a pipeline of named stages, each with an entry condition and
 * an exit condition. This file records the transitions into a single file in
 * the project so a founder (or any agent) can read where the project stands
 * without untangling tool-call transcripts.
 *
 * Ordering is legal: transitioning to a stage is only permitted when the
 * previous active stage has emitted its record. `blocked` and `failed` are
 * legal terminal/standing states for any in-flight stage.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const FACTORY_STAGES = [
  "intent",      // a founder asked for something
  "fit",         // factory-fit assessment, before the plan is written
  "plan",        // a plan exists on disk
  "team_proposal",
  "dispatch",    // workers are running (or have just run)
  "observe",     // mid-run / result of observation, before integrate
  "integrate",   // worktrees collected, merged
  "verify",      // blocking checks re-run on disk
  "retrospect",  // .cubicore-factory-ledger.json written; verdict issued
  "archive",     // history.jsonl appended
] as const;

export type FactoryStage = (typeof FACTORY_STAGES)[number] | "blocked" | "failed";
export type FactoryStageStatus = "entered" | "completed" | "blocked" | "failed" | "skipped";

export interface FactoryStageRecord {
  stage: FactoryStage;
  status: FactoryStageStatus;
  enteredAt: number;
  completedAt: number | null;
  elapsedMs: number | null;
  detail?: string;
}

export interface FactoryLifecycle {
  version: 2;
  stage: FactoryStage;
  history: FactoryStageRecord[];
  updatedAt: number;
}

const LIFECYCLE_FILE = ".cubicore-factory-state.json";

function readLifecycle(directory: string): FactoryLifecycle {
  try {
    const raw = readFileSync(`${directory}/${LIFECYCLE_FILE}`, "utf8");
    const parsed = JSON.parse(raw) as FactoryLifecycle;
    if (parsed && parsed.version === 2 && Array.isArray(parsed.history)) return parsed;
  } catch {
    // Fresh start.
  }
  return { version: 2, stage: "intent", history: [], updatedAt: Date.now() };
}

function writeLifecycle(directory: string, lifecycle: FactoryLifecycle): void {
  writeFileSync(`${directory}/${LIFECYCLE_FILE}`, JSON.stringify(lifecycle, null, 2));
}

/** Enter a stage. If a stage is already active, it is completed first. */
export function enterFactoryLifecycle(directory: string, stage: FactoryStage, detail?: string): void {
  const lifecycle = readLifecycle(directory);
  const now = Date.now();
  const active = lifecycle.history[lifecycle.history.length - 1];
  if (active && active.status !== "completed" && active.status !== "failed") {
    active.status = "completed";
    active.completedAt = now;
    active.elapsedMs = now - active.enteredAt;
  }
  lifecycle.history.push({ stage, status: "entered", enteredAt: now, completedAt: null, elapsedMs: null, ...(detail ? { detail } : {}) });
  lifecycle.stage = stage;
  lifecycle.updatedAt = now;
  writeLifecycle(directory, lifecycle);
}

/** Mark the active stage completed. */
export function completeFactoryLifecycle(directory: string, detail?: string): void {
  const lifecycle = readLifecycle(directory);
  const now = Date.now();
  const active = lifecycle.history[lifecycle.history.length - 1];
  if (active && active.status !== "completed" && active.status !== "failed") {
    active.status = "completed";
    active.completedAt = now;
    active.elapsedMs = now - active.enteredAt;
    if (detail) active.detail = detail;
  }
  lifecycle.updatedAt = now;
  writeLifecycle(directory, lifecycle);
}

/** Mark a stage blocked — with a reason, not forever retry-loop. */
export function blockFactoryLifecycle(directory: string, detail: string): void {
  const lifecycle = readLifecycle(directory);
  const now = Date.now();
  const active = lifecycle.history[lifecycle.history.length - 1];
  if (active) {
    active.status = "blocked";
    active.completedAt = now;
    active.elapsedMs = now - active.enteredAt;
    active.detail = detail;
  } else {
    lifecycle.history.push({ stage: "blocked", status: "blocked", enteredAt: now, completedAt: now, elapsedMs: 0, detail });
  }
  lifecycle.stage = "blocked";
  lifecycle.updatedAt = now;
  writeLifecycle(directory, lifecycle);
}

/** Read the lifecycle state for the factory. */
export function readFactoryLifecycle(directory: string): FactoryLifecycle {
  return readLifecycle(directory);
}

/** Context-flag the lifecycle file to show the current stage. */
export function factoryLifecycleStatusLine(directory: string): string {
  const lifecycle = readLifecycle(directory);
  const now = Date.now();
  const active = lifecycle.history[lifecycle.history.length - 1];
  const stage = lifecycle.stage;
  const label = (() => {
    switch (stage) {
      case "intent": return "waiting for a founder to say what must be built";
      case "fit": return "deciding whether this task deserves a team";
      case "plan": return "writing the plan — not dispatching yet";
      case "team_proposal": return "waiting for the founder's team-vs-agent answer";
      case "dispatch": return "dispatching the team";
      case "observe": return "workers are writing, checks green/red in progress";
      case "integrate": return "merging worker output into the tree";
      case "verify": return "re-running the blocking checks on disk";
      case "retrospect": return "writing the retrospective verdict and ledger";
      case "archive": return "appending the run to the archive";
      case "blocked": return "blocked — needs the founder or an intervention";
      case "failed": return "failed — see the lifecycle record and the plan";
      default: return String(stage);
    }
  })();
  const elapsed = active ? ((now - active.enteredAt) / 1000).toFixed(1) : "0";
  const detail = active?.detail ? ` — ${active.detail}` : "";
  return `stage: ${stage} (${elapsed}s)${detail}`;
}

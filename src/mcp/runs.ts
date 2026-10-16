import type { Plan } from "../contracts/types";

/**
 * In-flight and finished runs, keyed by id.
 *
 * The dispatch used to block the tool call until every associate finished, so
 * any run longer than the client's timeout returned nothing at all -- the work
 * landed and the founder was told nothing. Worse, a timeout is
 * indistinguishable from a hang, so the only safe response was to verify by
 * hand.
 *
 * `execute` now returns as soon as the run starts and `status` polls for the
 * result. A timeout can no longer lose a verdict, because there is nothing
 * long left to time out.
 *
 * Process-local by design: an MCP server is one process per client, and a
 * restart legitimately loses a run.
 */

export interface Run {
  id: string;
  startedAt: number;
  plan: Plan;
  state: "running" | "done" | "failed";
  summary?: string;
  error?: string;
}

const runs = new Map<string, Run>();

export function startRun(plan: Plan): Run {
  const run: Run = { id: `run-${Date.now().toString(36)}`, startedAt: Date.now(), plan, state: "running" };
  runs.set(run.id, run);
  return run;
}

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function finishRun(id: string, summary: string): void {
  const run = runs.get(id);
  if (run) runs.set(id, { ...run, state: "done", summary });
}

export function failRun(id: string, error: string): void {
  const run = runs.get(id);
  if (run) runs.set(id, { ...run, state: "failed", error });
}

/** Human-readable status, so a poll needs no parsing. */
export function describe(run: Run): string {
  const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
  if (run.state === "running") {
    return `run ${run.id}: running, ${run.plan.contracts.length} associates, ${elapsed}s elapsed`;
  }
  if (run.state === "failed") return `run ${run.id}: failed after ${elapsed}s — ${run.error}`;
  return `run ${run.id}: done in ${elapsed}s\n\n${run.summary}`;
}

import type { WorkerSessions } from "../dispatch/spawn";

/**
 * Surfaces orchestration progress while the dispatch is still running.
 *
 * The `cubicore` tool is a single blocking call. Without this, eight
 * associates working for two minutes is indistinguishable from a hang -- and
 * the founder cannot tell a slow run from a dead one. Every event is written
 * to stderr, which lands in the opencode server log and survives whatever the
 * TUI does with a long-running tool call.
 *
 * Deliberately not the tool's return value: that only arrives once the run has
 * already finished, which is exactly too late to be useful.
 */

const started = Date.now();

function stamp(): string {
  return `${String(Date.now() - started).padStart(7, " ")}ms`;
}

export function progressReporter(contracts: readonly { id: string }[]) {
  const names = contracts.map((c) => c.id);
  const width = Math.max(0, ...names.map((n) => n.length));
  const total = names.length;
  const state = new Map<string, string>();
  let done = 0;

  const line = (event: string, contractId: string, detail?: Record<string, unknown>) => {
    state.set(contractId, event);
    const extra =
      detail && "settled" in detail
        ? ` settled=${String(detail.settled)}`
        : detail && "attempt" in detail
          ? ` attempt=${String(detail.attempt)}`
          : "";
    if (event === "worker.idle") done++;

    const board = names
      .map((n) => {
        const marker =
          state.get(n) === "worker.idle" ? "done" : state.get(n) === "prompted" ? "run " : "wait";
        return `${n.padEnd(width)} ${marker}`;
      })
      .join("  ");

    process.stderr.write(`[cubicore ${stamp()}] ${event.padEnd(16)} ${contractId.padEnd(width)}${extra}\n`);
    process.stderr.write(`[cubicore ${stamp()}] progress ${done}/${total} | ${board}\n`);
  };

  return {
    /** `WorkerSessions` trace sink. */
    trace: (event: string, detail?: Record<string, unknown>) => {
      if (detail && typeof detail.contractId === "string") {
        line(event, detail.contractId, detail);
      }
    },
  };
}
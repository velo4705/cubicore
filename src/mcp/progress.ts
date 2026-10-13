/**
 * Streams orchestration progress while a run is still going.
 *
 * A dispatch is one blocking operation. Without this, four associates working
 * for thirty seconds is indistinguishable from a hang -- and the founder
 * cannot tell a slow run from a dead one. Every event is written to stderr as
 * it happens, alongside a live board of per-contract state.
 *
 * Deliberately not the tool's return value: that only arrives once the run has
 * already finished, which is exactly too late to be useful.
 */

export class ProgressSink {
  private readonly started = Date.now();
  private readonly names: string[];
  private readonly state = new Map<string, string>();
  private done = 0;

  constructor(contracts: readonly { id: string }[]) {
    this.names = contracts.map((c) => c.id);
  }

  /** `WorkerSessions` trace sink. */
  readonly trace = (event: string, detail?: Record<string, unknown>): void => {
    if (detail && typeof detail.contractId === "string") {
      this.line(event, detail.contractId, detail);
    }
  };

  private get width(): number {
    return Math.max(0, ...this.names.map((n) => n.length));
  }

  private stamp(): string {
    return `${String(Date.now() - this.started).padStart(7, " ")}ms`;
  }

  private line(event: string, contractId: string, detail?: Record<string, unknown>): void {
    this.state.set(contractId, event);

    const extra =
      detail && "settled" in detail
        ? ` settled=${String(detail.settled)}`
        : detail && "attempt" in detail
          ? ` attempt=${String(detail.attempt)}`
          : "";

    if (event === "worker.idle") this.done++;

    const board = this.names
      .map((name) => {
        const current = this.state.get(name);
        const marker = current === "worker.idle" ? "done" : current === "prompted" ? "run " : "wait";
        return `${name.padEnd(this.width)} ${marker}`;
      })
      .join("  ");

    const prefix = `[cubicore ${this.stamp()}]`;
    process.stderr.write(`${prefix} ${event.padEnd(16)} ${contractId.padEnd(this.width)}${extra}\n`);
    process.stderr.write(`${prefix} progress ${this.done}/${this.names.length} | ${board}\n`);
  }
}
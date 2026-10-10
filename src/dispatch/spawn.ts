import type { Contract, WorkerResult } from "../contracts/types";
import { RunObserver } from "./observe";
import { renderPrompt } from "./prompt";
import { routeModel, type ModelConfig } from "./routing";
import { BudgetEnforcer } from "./hooks";
import { deriveCaps } from "./budgets";
import type { WorkerRunner } from "./index";
import type { TokenUsage } from "../telemetry/types";

/**
 * Spawning one worker.
 *
 * This is the only place in `src/` allowed to be an unverified SDK wrapper, and
 * it is kept as narrow as that. The plugin already receives every event through
 * the `event` hook, so usage, tool counts and changed files are reconstructed by
 * `RunObserver` without a client call. Only *starting* the session needs the
 * SDK.
 *
 * VERIFY BEFORE TRUSTING: `create` / `prompt` / `changedFiles` are inferred
 * from the CLI's documented commands, not from installed types. If the method
 * names are wrong the fix is three names — everything they feed is already
 * tested. This file must not grow beyond spawning, prompting, and diffing.
 */

export interface SessionSpawner {
  create(): Promise<{ sessionId: string }>;
  /**
   * `agent` is deliberately optional and defaults to the host's default agent.
   *
   * An agent name the host does not know is accepted and SILENTLY ignored:
   * verified against opencode 1.18.x, where naming a nonexistent agent yields a
   * session whose messages all record `agent: build` and no error anywhere.
   * Passing an invented name therefore costs a dispatch and buys nothing, so
   * this interface does not require one.
   */
  prompt(sessionId: string, input: { agent?: string; text: string; model?: string }): Promise<void>;
  changedFiles(sessionId: string): Promise<string[]>;
  /**
   * UNVERIFIED. No cancel method appears in the docs, so this is optional and
   * its absence is the expected case today. Present so the ceiling path is
   * implemented and tested rather than waiting on the answer — a session is
   * only genuinely stopped if the host provides this.
   *
   * Without it, hitting the wall clock means Cubicore stops waiting while the
   * worker may keep spending. That is recorded honestly in the result rather
   * than reported as a kill.
   */
  cancel?(sessionId: string): Promise<void>;
}

/**
 * Owns the fan-out's event subscription.
 *
 * The bus is global and shared, so the plugin wires `onEvent` exactly once and
 * this class routes to the right worker. Each observer filters by session, which
 * is what keeps siblings from contaminating each other's totals.
 *
 * Owning the subscription here — rather than per call — is what stops observers
 * stacking up across a fan-out and mutating shared state.
 */
export class WorkerSessions {
  private readonly observers = new Map<string, RunObserver>();

  constructor(
    private readonly spawner: SessionSpawner,
    private readonly models?: ModelConfig,
    private readonly enforcer?: BudgetEnforcer,
    /**
     * True usage for a finished session. Event-fed usage is unreliable —
     * verified: a session recording 34,539 input tokens emitted zero-usage
     * events throughout. Without this the reported cost is always zero.
     */
    private readonly resolveUsage?: (sessionId: string) => TokenUsage,
    private readonly trace?: (event: string, detail?: Record<string, unknown>) => void,
  ) {}

  /** Wire this to the plugin's `event` hook, once. */
  onEvent(event: unknown): void {
    for (const observer of this.observers.values()) observer.on(event);
  }

  get inFlight(): number {
    return this.observers.size;
  }

  async run(contract: Contract, attempt = 0): Promise<WorkerResult> {
    const startedAt = Date.now();
    const observer = new RunObserver();
    const routing = this.models
      ? routeModel(contract, this.models, { attempt })
      : undefined;

    const { sessionId } = await this.spawner.create();
    observer.attach(sessionId);
    this.trace?.("worker.created", { contractId: contract.id, sessionId, attempt });
    this.observers.set(contract.id, observer);
    this.enforcer?.register(sessionId, contract.id, deriveCaps(contract));

    try {
      await this.spawner.prompt(sessionId, {
        text: renderPrompt(contract),
        model: routing?.model,
      });

      this.trace?.("worker.prompted", { contractId: contract.id, sessionId });
      const settled = await waitFor(
        () => observer.snapshot().idle,
        contract.budget.wallMs,
      );

      // Reaching here without an idle session means the worker blew its wall
      // budget. Ask the host to cancel; whether that actually stops the spend
      // depends on `cancel` existing, which is why the result reports the
      // distinction instead of collapsing it.
      let cancelled = false;
      if (!settled) {
        this.enforcer?.recordWallClockOverrun(sessionId);
        if (this.spawner.cancel) {
          await this.spawner.cancel(sessionId);
          cancelled = true;
        }
      }

      this.trace?.("worker.idle", { contractId: contract.id, settled });
      const snapshot = observer.snapshot();

      const changedFiles =
        snapshot.changedFiles.length > 0
          ? snapshot.changedFiles
          : await this.spawner.changedFiles(sessionId);

      return {
        contractId: contract.id,
        // A session error is a failure; an unfinished session is a budget kill.
        // The two must stay distinguishable or exhaustion looks like success.
        status: snapshot.error ? "failed" : settled ? "accepted" : "budget-exhausted",
        changedFiles,
        usage: this.resolveUsage ? this.resolveUsage(sessionId) : snapshot.usage,
        ms: Date.now() - startedAt,
        toolCalls: snapshot.toolCalls,
        cancelled,
      };
    } finally {
      this.observers.delete(contract.id);
      this.enforcer?.release(sessionId);
    }
  }

  asRunner(): WorkerRunner {
    return { run: (contract, attempt) => this.run(contract, attempt) };
  }
}

/** Resolves true when the condition holds, false when the budget runs out. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  if (condition()) return true;

  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      resolve(false);
    }, timeoutMs);

    const poll = setInterval(() => {
      if (!condition()) return;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(true);
    }, 25);
  });
}

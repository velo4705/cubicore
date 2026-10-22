import type { Artifact, Contract, WorkerResult } from "../contracts/types";
import { RunObserver } from "./observe";
import { renderPrompt } from "./prompt";
import { changedFilesSince } from "./changes";
import { collectWorktree, createWorktree, removeWorktree, type Worktree } from "./worktree";
import { routeModel, type ModelConfig } from "./routing";
import { BudgetEnforcer } from "../adapters/opencode/hooks";
import { deriveCaps } from "./budgets";
import type { WorkerRunner } from "./index";
import { addUsage, EMPTY_USAGE, type TokenUsage } from "../telemetry/types";

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
  create(input?: { title?: string }): Promise<{ sessionId: string }>;
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
  /** The worktree each associate worked in, so only approved work is collected. */
  private readonly worktrees = new Map<string, Worktree>();
  /** Finished workers, so run-level cost can be reported after dispatch. */
  private readonly settled: WorkerResult[] = [];

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
    /** The project root, and the baseline commit its changes are measured against. */
    private readonly root: string = process.cwd(),
    private readonly baseline?: string,
    /** Give each associate its own worktree. Off means they share the tree. */
    private readonly isolate = true,
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

    // Isolation first: the associate works in its own checkout of the
    // repository, so two workers cannot be in the same file at the same
    // moment. opencode 1.18.x cannot restrict an agent to a path, so the
    // boundary has to be the filesystem.
    const worktree = this.isolate ? createWorktree(this.root, contract) : undefined;

    const { sessionId } = await this.spawner.create({
      title: `${contract.id} (associate)`,
      ...(worktree && !worktree.degraded ? { directory: worktree.path } : {}),
    });
    observer.attach(sessionId);
    this.trace?.("worker.created", { contractId: contract.id, sessionId, attempt });
    this.observers.set(contract.id, observer);
    if (worktree) this.worktrees.set(contract.id, worktree);
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

      // Per-worker attribution comes from the event stream: `file.edited`
      // carries the session id, so each associate's changes are its own.
      //
      // Git is only a fallback, and it is a weaker one: in a shared tree the
      // diff shows every worker's changes, so a parallel associate would look
      // like a scope violation. Preferring git over the event stream would
      // manufacture exactly that false positive.
      const observed = snapshot.changedFiles;
      const fromSpawner = observed.length > 0 ? [] : await this.spawner.changedFiles(sessionId);
      const fromGit =
        observed.length > 0 || fromSpawner.length > 0
          ? { files: [], unknown: false }
          : await changedFilesSince(this.root, this.baseline);
      const changedFiles =
        observed.length > 0 ? observed : fromSpawner.length > 0 ? fromSpawner : fromGit.files;
      const changesUnknown =
        observed.length === 0 && fromSpawner.length === 0 && fromGit.unknown;

      const result: WorkerResult = {
        contractId: contract.id,
        // A session error is a failure; an unfinished session is a budget kill.
        // The two must stay distinguishable or exhaustion looks like success.
        status: snapshot.error ? "failed" : settled ? "accepted" : "budget-exhausted",
        changedFiles,
        usage: this.resolveUsage ? this.resolveUsage(sessionId) : snapshot.usage,
        ms: Date.now() - startedAt,
        toolCalls: snapshot.toolCalls,
        cancelled,
        artifact: buildArtifact(contract, snapshot, changedFiles),
        changesUnknown,
      };
      this.settled.push(result);
      return result;
    } finally {
      this.observers.delete(contract.id);
      this.enforcer?.release(sessionId);
    }
  }

  /**
   * True usage summed across every worker that has finished.
   *
   * Event-fed usage is always zero -- verified, a session recording 34,539
   * input tokens emitted zero-usage events throughout -- so this is read from
   * the session rows rather than observed. Without it the reported cost of a
   * run is zero, which makes the benchmark meaningless.
   */
  settledUsage(): TokenUsage {
    let total = EMPTY_USAGE;
    for (const result of this.settled) total = addUsage(total, result.usage);
    return total;
  }

  /**
   * Collect a finished worker's work, once the gates have passed.
   *
   * The order matters and it is the whole point of a worktree: the worker's
   * files stay in its own checkout until its checks have passed. Collecting in
   * a `finally` would integrate the changes of a worker whose gates failed,
   * which is integrating unapproved work.
   */
  collect(contractId: string): { copied: string[]; missing: string[] } {
    const worktree = this.worktrees.get(contractId);
    if (!worktree) return { copied: [], missing: [] };

    const result = collectWorktree(worktree, this.root);
    removeWorktree(worktree, this.root);
    this.worktrees.delete(contractId);
    return result;
  }

  /** Discard a finished worker's work without integrating it. */
  discard(contractId: string): void {
    const worktree = this.worktrees.get(contractId);
    if (!worktree) return;
    removeWorktree(worktree, this.root);
    this.worktrees.delete(contractId);
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

/**
 * Turns a finished session into the typed artifact the gates check.
 *
 * This step had no owner. `WorkerResult.artifact` was declared optional, no
 * producer ever set it, and `dispatch` fell back to `emptyArtifact`, so every
 * contract failed the schema gate with "artifact was empty" and reported zero
 * passes while the work itself had succeeded. The type permitted the hole by
 * making the field optional, which is why nothing caught it.
 *
 * `raw` is derived from what the worker demonstrably produced -- the files it
 * wrote -- rather than from its prose, so correctness never depends on the
 * model cooperating with the format. A worker that answered with a description
 * instead of doing the work yields an empty file list, and the scope gate
 * rejects it, which is the behaviour we want.
 */
function buildArtifact(
  contract: Contract,
  snapshot: { texts: readonly string[] },
  changedFiles: readonly string[],
): Artifact {
  const prose = snapshot.texts.join("\n").trim();
  const files = JSON.stringify({ files: changedFiles });

  // A structured deliverable must satisfy the contract's schema, so `raw` is
  // JSON. A worker whose prose is not valid JSON must not fail on formatting,
  // so prose is only used when it actually parses; otherwise the demonstrable
  // file list stands in. Either way the artifact is derived from what the
  // worker did rather than from how it phrased the answer.
  let body = files;
  if (contract.deliverable !== "diff" && prose.length > 0) {
    try {
      JSON.parse(prose);
      body = prose;
    } catch {
      body = files;
    }
  }

  return { contractId: contract.id, deliverable: contract.deliverable, raw: body };
}

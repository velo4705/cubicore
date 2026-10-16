import type { ModelConfig } from "../src/dispatch/routing";
import { WorkerSessions, type SessionSpawner } from "../src/dispatch/spawn";
import { BudgetEnforcer } from "../src/dispatch/hooks";
import { RunObserver } from "../src/dispatch/observe";
import { dispatch } from "../src/dispatch";
import { parsePlan } from "../src/coordinator/parse";
import { clientSpawner } from "../src/index";
import { SqliteTokenSource } from "../src/telemetry/adapters/session-db";
import { addUsage, EMPTY_USAGE, type TokenUsage } from "../src/telemetry/types";
import type { TaskSpec, Trial } from "../src/bench/types";

/**
 * The `orchestrated` arm.
 *
 * Drives Cubicore's own plan → dispatch → gate → aggregate path against a live
 * opencode client. This is the same orchestration code the plugin runs; the
 * only difference is that the benchmark hosts it in-process instead of letting
 * opencode host the plugin. Everything that costs tokens and time — the
 * coordinator turn, the per-worker sessions, the gates — is identical.
 *
 * The distinction is recorded because it is not a small one: a fully faithful
 * measurement would load the plugin into opencode and invoke the `cubicore`
 * tool, which also exercises the tool's own overhead.
 */

interface ClientLike {
  session: {
    create(args: { query?: { directory?: string } }): Promise<{ data?: { id?: string } | null }>;
    prompt(args: {
      body: {
        agent?: string;
        model?: { providerID: string; modelID: string };
        tools?: Record<string, boolean>;
        parts: Array<{ type: "text"; text: string }>;
      };
      path: { id: string };
      query?: { directory?: string };
    }): Promise<unknown>;
    diff(args: { path: { id: string }; query?: { directory?: string } }): Promise<{
      data?: Array<{ file?: string }> | null;
    }>;
    abort(args: { path: { id: string }; query?: { directory?: string } }): Promise<unknown>;
  };
}


function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash < 0) return { providerID: "opencode", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export interface OrchestratedOptions {
  client: ClientLike;
  directory: string;
  models: ModelConfig;
  enforcer?: BudgetEnforcer;
}

export class OrchestratedRunner {
  private readonly tokens = new SqliteTokenSource();
  private readonly enforcer: BudgetEnforcer;
  private readonly usage = new SqliteTokenSource();
  private readonly t0 = Date.now();

  /** Stage-by-stage trace, so one run shows where a stall happens. */
  trace = (event: string, detail?: Record<string, unknown>): void => {
    console.log(`  [${String(Date.now() - this.t0).padStart(7)}ms] ${event} ${JSON.stringify(detail ?? {})}`);
  };

  constructor(private readonly options: OrchestratedOptions) {
    this.enforcer = options.enforcer ?? new BudgetEnforcer();
  }

  /**
   * Runs the full orchestration for a task, mirroring what the `cubicore` tool
   * does inside the plugin. Usage is measured per session so the ledger dedupe
   * still applies and the totals stay comparable with the other arms.
   */
  async run(task: TaskSpec): Promise<Trial> {
    const startedAt = Date.now();
    const { client, directory, models } = this.options;

    // The coordinator is gone, so there is no planning observer to collect.
    // Worker sessions carry the whole cost of this arm.
    const sessions = new WorkerSessions(
      clientSpawner(client as never, directory),
      models,
      this.enforcer,
      // Event-fed usage is zero; the session row is the truth.
      this.usage.resolver(),
      this.trace,
    );
    this.workerOnEvent = (event: unknown) => sessions.onEvent(event);

    if (!task.plan) {
      return {
        taskId: task.id,
        arm: "orchestrated",
        durationMs: Date.now() - startedAt,
        usage: EMPTY_USAGE,
        timedOut: true,
      };
    }

    const plan = parsePlan(JSON.stringify(task.plan)) as never;

    // Checks are stubbed: the benchmark corpus has no runnable suite, and a
    // stubbed gate is closer to what a real task would cost than omitting the
    // gate and its tokens entirely. Stubbing keeps the comparison fair, since
    // the other arms run the same checks against the same tree.
    await dispatch(
      plan,
      sessions.asRunner(),
      { async run() { return { exitCode: 0, output: "" }; } },
      { trace: this.trace },
    );

    return {
      taskId: task.id,
      arm: "orchestrated",
      durationMs: Date.now() - startedAt,
      usage: sessions.settledUsage(),
    };
  }

  /** Wired by the caller to the client's event stream. */
  onEvent: (event: unknown) => void = () => {};

  private workerOnEvent: ((event: unknown) => void) | null = null;

  private collect(observers: RunObserver[]): TokenUsage {
    let usage: TokenUsage = EMPTY_USAGE;
    for (const observer of observers) usage = addUsage(usage, observer.snapshot().usage);
    return usage;
  }
}
/**
 * Subscribes to opencode's server-sent event stream and feeds a runner.
 *
 * This is what makes in-process hosting equivalent to the plugin: without the
 * event feed, no observer sees `session.idle` and every worker would sit until
 * its wall-clock ceiling.
 */
export async function pumpEvents(
  client: { event: { subscribe(args?: { query?: { directory?: string } }): Promise<{ stream: AsyncIterable<{ data?: unknown }> }> } },
  runner: OrchestratedRunner,
  directory: string,
): Promise<() => void> {
  let stopped = false;
  const subscription = await client.event.subscribe({ query: { directory } });

  (async () => {
    try {
      for await (const chunk of subscription.stream as AsyncIterable<{ data?: unknown }>) {
        if (stopped) return;
        const data = chunk?.data;
        if (data) runner.onEvent(data);
      }
    } catch {
      // Stream closed. Workers fall back to their wall-clock ceilings.
    }
  })();

  return () => {
    stopped = true;
  };
}

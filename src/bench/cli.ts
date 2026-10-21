import type { TokenUsage } from "../telemetry/types";
import type { Runner, RunRequest } from "./runner";
import type { TokenSource } from "./runner";
import { SqliteTokenSource } from "./tokens";
import type { Database as SqliteDatabase } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { defaultDbPath } from "./tokens";

/**
 * Driving opencode from the command line.
 *
 * The benchmark shells out rather than loading the plugin, deliberately: the
 * plugin grading its own runs is the circularity this project exists to warn
 * about. It also means the same harness works for any provider with a CLI.
 *
 * Session identity is recovered from the database rather than parsed out of
 * stdout. `opencode run --format json` does not emit token data (#31404) and
 * prints the prompt back for humans by default, so stdout is not a reliable
 * source of either measurement or identity. Sessions carry a `directory`
 * column, which is what disambiguates a fresh run from an older one in the
 * same project.
 */

export interface CliRunnerOptions {
  model?: string;
  cwd: string;
  dbPath?: string;
  /** Retained so a failed run still yields whatever the session recorded. */
  timeoutMs?: number;
  onOutput?: (text: string) => void;
}

export class CliRunner implements Runner {
  private readonly db: SqliteDatabase;

  constructor(private readonly options: CliRunnerOptions) {
    this.db = new Database(options.dbPath ?? defaultDbPath(), { readonly: true });
  }

  async run(request: RunRequest): Promise<{ sessionId: string; durationMs: number }> {
    const startedAt = Date.now();

    const args = ["run"];
    if (this.options.model) args.push("--model", this.options.model);
    args.push(request.prompt);

    const proc = Bun.spawn(["opencode", ...args], {
      cwd: this.options.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    let output = "";
    try {
      // A worker that hangs must not hang the arm. Without a deadline one
      // stalled model session holds the whole benchmark open indefinitely, and
      // a run that never finishes measures nothing. The killed worker is
      // reported as failed rather than silently dropped.
      const timeoutMs = this.options.timeoutMs ?? 300_000;
      const timedOut = Symbol("timeout");
      const exit = await Promise.race([
        proc.exited,
        Bun.sleep(timeoutMs).then(() => timedOut),
      ]);

      if (exit === timedOut) {
        proc.kill();
        throw new Error(`worker exceeded ${timeoutMs}ms and was terminated`);
      }

      output = await new Response(proc.stdout).text();
      this.options.onOutput?.(output);
    } finally {
      proc.kill();
    }

    const durationMs = Date.now() - startedAt;
    const sessionId = this.newestSessionId();

    if (!sessionId) {
      throw new Error(
        `could not identify the session created under ${this.options.cwd}; ` +
          `a run with no session record cannot be measured`,
      );
    }

    return { sessionId, durationMs };
  }

  /**
   * Newest session in this working directory. Matching on directory matters:
   * the database holds every session from every project, and the newest overall
   * is usually unrelated to the run that just finished.
   */
  private newestSessionId(): string | null {
    const row = this.db
      .query(
        "SELECT id FROM session WHERE directory = ? ORDER BY time_created DESC LIMIT 1",
      )
      .get(this.options.cwd);
    return row ? String((row as { id: string }).id) : null;
  }
}

/** Pairs the CLI runner with the session-database token source. */
export function benchRunner(options: CliRunnerOptions): {
  run: Runner;
  tokens: TokenSource;
} {
  const tokens = new SqliteTokenSource({ path: options.dbPath });
  return { run: new CliRunner(options), tokens };
}

/**
 * Convenience for a single trial: returns both the measured duration and the
 * usage the database recorded.
 */
export async function measureOnce(
  runner: Runner,
  tokens: TokenSource,
  request: RunRequest,
): Promise<{ durationMs: number; usage: TokenUsage }> {
  const { sessionId, durationMs } = await runner.run(request);
  return { durationMs, usage: await tokens.read(sessionId) };
}
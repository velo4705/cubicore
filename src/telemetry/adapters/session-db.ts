import { Database } from "bun:sqlite";
import type { TokenUsage } from "../types";
import { readUsage } from "./opencode";

/**
 * Reading usage from opencode's session database.
 *
 * This is the **only accurate usage source found.** Verified against a live
 * server: a session recording 34,539 input tokens emitted `message.updated`
 * events whose `tokens` block was `{ input: 0, output: 0, ... }` every time.
 * Event-fed accounting reports zero for every run.
 *
 * The `session` table carries denormalised columns — `tokens_input`,
 * `tokens_output`, `tokens_reasoning`, `tokens_cache_read`,
 * `tokens_cache_write`, `cost` — alongside `time_created` / `time_updated`. So
 * a measurement is a single row read rather than a scan of `message`, and it
 * cannot double-count the repeated events streaming emits.
 *
 * Lives under `telemetry/adapters/` because it is provider-specific. The core
 * never imports it; `worker sessions` receive it as an injected resolver.
 */

export interface SessionRead {
  usage: TokenUsage;
  /** Session span. Session *lifetime*, not work time — see note below. */
  durationMs: number | null;
  found: boolean;
}

export interface TokenDb {
  sessionRow(sessionId: string): Record<string, unknown> | null;
  messageData(sessionId: string): unknown[];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readSession(db: TokenDb, sessionId: string): SessionRead {
  const row = db.sessionRow(sessionId);

  if (row && (row.tokens_input !== undefined || row.cost !== undefined)) {
    const created = num(row.time_created);
    const updated = num(row.time_updated);
    return {
      usage: {
        input: num(row.tokens_input),
        output: num(row.tokens_output),
        reasoning: num(row.tokens_reasoning),
        cacheRead: num(row.tokens_cache_read),
        cacheWrite: num(row.tokens_cache_write),
        cost: num(row.cost),
      },
      durationMs: updated > 0 && updated >= created ? updated - created : null,
      found: true,
    };
  }

  // Fallback for a schema without the denormalised columns.
  const seen = new Set<string>();
  let usage: TokenUsage = {
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  };
  let found = false;

  for (const raw of db.messageData(sessionId)) {
    const message = typeof raw === "string" ? safeParse(raw) : raw;
    if (!isRecord(message)) continue;

    const id = typeof message.id === "string" ? message.id : null;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }

    const one = readUsage(message);
    if (!one) continue;
    found = true;
    usage = {
      input: usage.input + one.input,
      output: usage.output + one.output,
      reasoning: usage.reasoning + one.reasoning,
      cacheRead: usage.cacheRead + one.cacheRead,
      cacheWrite: usage.cacheWrite + one.cacheWrite,
      cost: usage.cost + one.cost,
    };
  }

  return { usage, durationMs: null, found };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `opencode db path` first. A NixOS install keeps its database under `~/.var/app`,
 * a Nix-Store install under `~/.local/share`; guessing finds a stale database and
 * reports zero usage for every session, which looks like a measurement bug.
 */
export function defaultDbPath(): string {
  const override = process.env.CUBICORE_OPENCODE_DB;
  if (override) return override;

  const fromCli = queryCliDbPath();
  if (fromCli) return fromCli;

  return `${process.env.HOME ?? ""}/.local/share/opencode/opencode-stable.db`;
}

function queryCliDbPath(): string | null {
  try {
    const result = Bun.spawnSync(["opencode", "db", "path"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
    });
    const path = result.stdout.toString().trim();
    return result.exitCode === 0 && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

export class SqliteTokenSource {
  private connection: TokenDb | null = null;
  private readonly path: string;

  constructor(options: { path?: string } = {}) {
    this.path = options.path ?? defaultDbPath();
  }

  /** Synchronous — a local read with no network hop. */
  read(sessionId: string): TokenUsage {
    return this.readSession(sessionId).usage;
  }

  readSession(sessionId: string): SessionRead {
    return readSession(this.db(), sessionId);
  }

  /** Injected as `resolveUsage` so no layer depends on this class. */
  resolver(): (sessionId: string) => TokenUsage {
    return (sessionId) => this.read(sessionId);
  }

  /**
   * Sessions created in a directory since a moment.
   *
   * A benchmark arm is measured by the sessions it caused, and "since" is the
   * only reliable way to attribute them: the database holds every session
   * from every project, and the newest overall is usually unrelated.
   */
  sessionsSince(directory: string, since: number): string[] {
    const sqlite = new Database(this.path, { readonly: true });
    const rows = sqlite
      .query("SELECT id, time_created FROM session WHERE directory = ? AND time_created >= ?")
      .all(directory, since) as Array<{ id: string; time_created: number }>;
    return rows.map((r) => r.id);
  }

  private db(): TokenDb {
    if (this.connection) return this.connection;

    const sqlite = new Database(this.path, { readonly: true });
    this.connection = {
      sessionRow: (sessionId) => {
        const row = sqlite.query("SELECT * FROM session WHERE id = ?").get(sessionId);
        return isRecord(row) ? row : null;
      },
      messageData: (sessionId) =>
        sqlite
          .query("SELECT data FROM message WHERE session_id = ? ORDER BY time_created ASC")
          .all(sessionId),
    };
    return this.connection;
  }
}
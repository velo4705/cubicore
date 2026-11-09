import { existsSync } from "node:fs";

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

  // The DB location depends on how the host was installed; checking the
  // candidates beats guessing wrong and reporting zero usage for every run.
  // An install can leave both a native and a Flatpak DB on disk, with the
  // live service writing to the other one. The newest session row decides,
  // not file existence.
  const home = process.env.HOME ?? "";
  const candidates = [
    `${home}/.local/share/opencode/opencode.db`, // v2 native install
    `${home}/.var/app/ai.opencode.opencode/data/opencode/opencode.db`, // Flatpak
    `${home}/.local/share/opencode/opencode-stable.db`, // legacy v1
  ];
  let best: { path: string; freshest: number } | undefined;
  for (const candidate of candidates) {
    const freshest = newestSessionMs(candidate);
    if (freshest === null) continue; // missing or unreadable
    if (!best || freshest > best.freshest) best = { path: candidate, freshest };
  }
  if (best) return best.path;
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // try the next
    }
  }
  return `${home}/.local/share/opencode/opencode.db`;
}

/**
 * Newest session row across the v2 and legacy tables, or null when the
 * candidate cannot be opened or has no sessions. Used only to pick which
 * candidate database the telemetry reads; a bad pick shows up as zeros, so
 * this is deliberately strict.
 */
export function newestSessionMs(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const sqlite = new Database(path, { readonly: true });
    for (const table of ["session_v2", "session"]) {
      try {
        const row = sqlite
          .query(`SELECT MAX(time_created) AS t FROM ${table}`)
          .get() as { t: number | null } | undefined;
        if (row && typeof row.t === "number" && row.t > 0) return row.t;
      } catch {
        // Table does not exist on this host; try the other.
      }
    }
    // Database opened but has no rows yet; prefer it over a missing file.
    return 0;
  } catch {
    return null;
  }
}

function queryCliDbPath(): string | null {
  try {
    const result = Bun.spawnSync(["opencode", "db", "path"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
    });
    const path = result.stdout.toString().trim();
    // `opencode db path` is not a real subcommand here; the help text it
    // prints used to be taken as a path, which failed to open and silently
    // zeroed every usage figure. A real path is one file, on one line, that
    // exists.
    return result.exitCode === 0 && path.length > 0 && !/\s/.test(path) && existsSync(path) ? path : null;
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
        // opencode 2.x writes `session_v2` (with `time_suspended`/`resume_attempts`)
        // and leaves `session` frozen. New sessions are always in v2; a v2 hit
        // wins, and the legacy table covers hosts that never migrated.
        for (const table of ["session_v2", "session"]) {
          try {
            const row = sqlite.query(`SELECT * FROM ${table} WHERE id = ?`).get(sessionId);
            if (isRecord(row)) return row;
            return null;
          } catch {
            // Table does not exist on this host; try the other.
          }
        }
        return null;
      },
      messageData: (sessionId) => {
        for (const table of ["session_message", "message"]) {
          try {
            return sqlite
              .query(`SELECT data FROM ${table} WHERE session_id = ? ORDER BY time_created ASC`)
              .all(sessionId);
          } catch {
            // Table does not exist; try the other.
          }
        }
        return [];
      },
    };
    return this.connection;
  }
}

/**
 * Newest session id in a directory, across v1 and v2 tables.
 *
 * Attribution for `opencode run`: each arm starts with a snapshot and demands
 * the new session differ from it. Mixed-era databases (v2 live alongside the
 * frozen v1 tables) need the union or the newest row is invisible to either
 * query alone.
 */
export function newestSessionId(
  path: string,
  directory: string,
  sinceMs = 0,
): string | null {
  const sqlite = new Database(path, { readonly: true });
  try {
    const row = sqlite
      .query(
        "SELECT id, MAX(time_created) AS t FROM (" +
          "SELECT id, time_created FROM session_v2 WHERE directory = ? AND time_created >= ? " +
          "UNION ALL " +
          "SELECT id, time_created FROM session WHERE directory = ? AND time_created >= ?" +
          ") GROUP BY id ORDER BY t DESC LIMIT 1",
      )
      .get(directory, sinceMs, directory, sinceMs) as { id: string } | null;
    return row?.id ?? null;
  } catch {
    try {
      const row = sqlite
        .query(
          "SELECT id FROM session WHERE directory = ? AND time_created >= ? " +
            "ORDER BY time_created DESC LIMIT 1",
        )
        .get(directory, sinceMs) as { id: string } | null;
      return row?.id ?? null;
    } catch {
      return null;
    }
  }
}

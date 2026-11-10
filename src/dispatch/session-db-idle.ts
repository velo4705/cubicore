/**
 * Read-only probe of the v2 session database: answers "has this session
 * terminally idled?" without opening sockets or subscribing to events.
 *
 * `time_idle` mirrors any of the event-stream signals (idle, succeeded,
 * interrupted, failed) — they all converge to "the session is now idle."
 * `idle_outcome` distinguishes the reason ('succeeded' | 'failed' |
 * 'interrupted') so callers can react instead of treating every idle
 * the same.
 */

import { Database } from "bun:sqlite";
import { defaultDbPath } from "../telemetry/adapters/session-db";

export interface SessionIdleResult {
  idle: boolean;
  outcome: string | null;
}

export function sessionIdleStatus(sessionId: string): SessionIdleResult {
  try {
    return tryIdleStatus(sessionId);
  } catch {
    // DB unreachable from this environment — dispatch still works,
    // the event-stream fallback stays the only kind of truth.
    return { idle: false, outcome: null };
  }
}

function tryIdleStatus(sessionId: string): SessionIdleResult {
  const db = new Database(defaultDbPath(), { readonly: true });
  try {
    for (const table of ["session_v2", "session"]) {
      try {
        const row = db
          .query(`SELECT time_idle, idle_outcome FROM ${table} WHERE id = ? LIMIT 1`)
          .get(sessionId) as { time_idle: number | null; idle_outcome: string | null } | undefined;
        if (!row) return { idle: false, outcome: null };
        return {
          idle: row.time_idle !== null && row.time_idle !== undefined,
          outcome: row.idle_outcome ?? null,
        };
      } catch {
        // table does not exist on this host
      }
    }
    return { idle: false, outcome: null };
  } finally {
    db.close();
  }
}

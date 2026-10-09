/**
 * Benchmark-side access to opencode's session database.
 *
 * The implementation now lives in `telemetry/adapters/session-db.ts`, because
 * it is provider-specific and the telemetry core is the correct layer for it.
 * This re-export keeps the benchmark's import path stable.
 */
export {
  SqliteTokenSource,
  defaultDbPath,
  readSession,
  type SessionRead,
  type TokenDb,
} from "../telemetry/adapters/session-db";

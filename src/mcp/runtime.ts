import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

import { clientSpawner } from "../index";
import { WorkerSessions } from "../dispatch/spawn";
import { SqliteTokenSource } from "../telemetry/adapters/session-db";
import { ProgressSink } from "./progress";

/**
 * Builds an opencode client from the environment an MCP server inherits.
 *
 * Verified: MCP servers launched by opencode receive OPENCODE_SERVER_USERNAME,
 * OPENCODE_SERVER_PASSWORD and OPENCODE_PID. No base URL is passed, so the port
 * comes from OPENCODE_PORT when set and otherwise from the loopback default the
 * plugin has always used.
 *
 * A plugin is handed its client. An MCP server has to go and find one, and this
 * is the only place that has to know how.
 */

export interface Runtime {
  client: OpencodeClient;
  /** Resolved loopback port of the opencode server. */
  port: string;
  directory: string;
  models: { strong: string; cheap: string };
}

/**
 * Find the loopback port the local opencode server is listening on.
 *
 * There is no fixed port: opencode binds an ephemeral one, and the MCP server
 * inherits credentials but no base URL. Guessing 4096 failed against a server
 * on 46447. Ask the socket table instead, and let an explicit OPENCODE_PORT
 * still win.
 *
 * `ss` is unavailable on some systems, in which case the caller's configured
 * port is the only option -- so this reports nothing rather than guessing.
 */
function discoverPort(): string | null {
  try {
    const { stdout } = Bun.spawnSync(["sh", "-c", "ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null"]);
    const table = new TextDecoder().decode(stdout);
    for (const line of table.split("\n")) {
      const match = /127\.0\.0\.1:(\d+)/.exec(line);
      if (match) return match[1];
    }
  } catch {
    // No socket table available.
  }
  return null;
}

export function runtimeFromEnv(env: Record<string, string | undefined> = process.env): Runtime {
  const username = env.OPENCODE_SERVER_USERNAME;
  const password = env.OPENCODE_SERVER_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "Cubicore MCP needs OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD. " +
        "When launched by opencode both are inherited; running standalone requires " +
        "`opencode serve` plus those two variables in the environment.",
    );
  }

  const configured = env.OPENCODE_PORT ?? env.OPENCODE_SERVER_PORT;
  const port = configured ?? discoverPort();
  if (!port) {
    throw new Error(
      "Cubicore MCP could not determine the opencode server port. opencode binds an " +
        "ephemeral port and does not pass it to MCP servers. Set OPENCODE_PORT " +
        "explicitly, or install `ss` (or netstat) so it can be discovered.",
    );
  }
  const directory = env.OPENCODE_CUBICORE_DIRECTORY ?? env.OPENCODE_WORKTREE ?? process.cwd();

  return {
    port,
    client: createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      directory,
      headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
    }) as OpencodeClient,
    directory,
    models: {
      strong: env.OPENCODE_CUBICORE_MODEL ?? "opencode/space-bunny-free",
      cheap: env.OPENCODE_CUBICORE_WORKER_MODEL ?? env.OPENCODE_CUBICORE_MODEL ?? "opencode/space-bunny-free",
    },
  };
}

/**
 * Worker sessions for one execution.
 *
 * Usage is read from the session database rather than events: live events
 * reported zero usage for a session that later recorded 34,539 input tokens,
 * so an event-fed cost is always zero.
 */
export function workerSessions(runtime: Runtime, progress?: ProgressSink): WorkerSessions {
  const db = new SqliteTokenSource();

  return new WorkerSessions(
    clientSpawner(runtime.client as never, runtime.directory),
    runtime.models,
    undefined as never,
    (sessionId: string) => {
      try {
        return db.read(sessionId);
      } catch {
        return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0 };
      }
    },
    progress?.trace,
  );
}
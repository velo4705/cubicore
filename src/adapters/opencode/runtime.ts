import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

import { authFromEnv, clientSpawner } from "./plugin";
import { servicePassword } from "../../mcp/service";
import { pickCallerSession, type ListedCallerSession } from "./caller";
import { WorkerSessions } from "../../dispatch/spawn";
import { SqliteTokenSource } from "../../telemetry/adapters/session-db";
import { DEFAULT_MODEL, resolveModel } from "../../mcp/model";
import { ProgressSink } from "../../mcp/progress";

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
  /** Base URL of the opencode server, for endpoints the SDK does not expose. */
  baseUrl: string;
  /** Resolved model, verified against the provider's list. */
  model: { id: string; verified: boolean; reason?: string };
  /** Resolved loopback port of the opencode server. */
  port: string;
  /** Parent session, so associates render as sub-agents in the host UI. */
  sessionID?: string;
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
  // `ss -ltn` lists every loopback listener with no process information, and
  // the first one is usually CUPS on :631 -- not opencode. Identifying the
  // owner is the whole point, so ask for `ss -ltnp` and match the process.
  for (const cmd of [
    "ss -ltnp 2>/dev/null | grep -i opencode",
    "ss -ltnp 2>/dev/null | grep -i 'ai.opencode'",
    "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i opencode",
  ]) {
    try {
      const { stdout, exitCode } = Bun.spawnSync(["sh", "-c", cmd]);
      if (exitCode !== 0) continue;
      const table = new TextDecoder().decode(stdout);
      const match = /127\.0\.0\.1:(\d+)/.exec(table);
      if (match) return match[1];
    } catch {
      // Try the next strategy.
    }
  }
  return null;
}

export function runtimeFromEnv(env: Record<string, string | undefined> = process.env): Runtime {
  const username = env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const password = env.OPENCODE_SERVER_PASSWORD ?? servicePassword();

  if (!password) {
    throw new Error(
      "Cubicore MCP needs a service password. OpenCode may inject OPENCODE_SERVER_PASSWORD " +
        "into MCP servers at launch, or it can be read from the host's service.json. " +
        "Neither was found. Restart OpenCode, or set both variables explicitly.",
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
    baseUrl: `http://127.0.0.1:${port}`,
    model: { id: env.OPENCODE_CUBICORE_MODEL ?? DEFAULT_MODEL, verified: false },
    client: createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      directory,
      headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
    }) as OpencodeClient,
    directory,
    models: {
      strong: env.OPENCODE_CUBICORE_MODEL ?? DEFAULT_MODEL,
      cheap: env.OPENCODE_CUBICORE_WORKER_MODEL ?? env.OPENCODE_CUBICORE_MODEL ?? DEFAULT_MODEL,
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
/**
 * The session most likely to be the caller.
 *
 * An MCP tool call carries no session id, so an agent cannot be asked to supply
 * one it has no way to know. The most recently created session in the working
 * directory is the Main agent that invoked the tool in every normal case, and
 * parenting to it is what makes associates render as sub-agents rather than
 * orphans.
 *
 * Best-effort by construction: if there is no recent session the run still
 * works, it just is not nested.
 */
export async function findCallerSession(
  runtime: Runtime,
): Promise<string | undefined> {
  try {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "";
    const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
    const response = await fetch(
      `${runtime.baseUrl}/api/session?directory=${encodeURIComponent(runtime.directory)}`,
      {
        headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) return undefined;
    const result = (await response.json()) as {
      data?: Array<ListedCallerSession>;
    };
    return pickCallerSession(result.data ?? []);
  } catch {
    return undefined;
  }
}

/**
 * Ask the provider which models it has, and check ours is among them.
 *
 * A model that has been removed fails silently: the prompt is accepted, the
 * user message is recorded, and no assistant reply ever arrives. A dispatch
 * built on one does nothing at all and reports nothing wrong. Verified --
 * `space-bunny-free` was withdrawn mid-session and every associate sat idle
 * until its wall budget expired.
 */
export async function verifyModel(
  runtime: Runtime,
  candidate?: string,
  auth?: string,
): Promise<{ id: string; verified: boolean; reason?: string }> {
  const wanted = candidate ?? runtime.model.id;

  try {
    // The model list lives on /provider, shaped { all: [...] }. It has been
    // three shapes across three endpoints -- an array on /config, an object
    // keyed by id on /config/providers, and { all: [...] } here -- and
    // reading the wrong one used to throw, and a throw refused to dispatch.
    // So: read this one, tolerate a few shapes, and treat "could not check"
    // as unknown rather than as a failure.
    const response = await fetch(`${runtime.baseUrl}/provider`, {
      headers: auth ? { Authorization: auth } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { id: wanted, verified: false, reason: `could not list the provider models: ${response.status}` };
    }

    const body = (await response.json()) as {
      all?: Array<{ id: string; models?: Record<string, unknown> }>;
    };
    const providers = Array.isArray(body.all) ? body.all : [];

    const available: string[] = [];
    for (const provider of providers) {
      for (const model of Object.keys(provider.models ?? {})) {
        available.push(`${provider.id}/${model}`);
      }
    }

    const resolved = resolveModel(available, wanted);
    runtime.model = { id: resolved.model, verified: resolved.ok, reason: resolved.reason };
    return runtime.model;
  } catch (error) {
    // Could not check. Say so rather than implying it was verified.
    runtime.model = {
      id: wanted,
      verified: false,
      reason: `Could not list the provider's models: ${error instanceof Error ? error.message : String(error)}`,
    };
    return runtime.model;
  }
}

export function workerSessions(
  runtime: Runtime,
  progress?: ProgressSink,
  /**
   * The project the work happens in.
   *
   * Distinct from the server's own working directory. The scope check reads
   * git status, and the worktrees are created under this root, so getting it
   * wrong means checking one repository while working in another.
   */
  root?: string,
): WorkerSessions {
  const db = new SqliteTokenSource();

  return new WorkerSessions(
    clientSpawner(
      { baseUrl: runtime.baseUrl, directory: runtime.directory, auth: authFromEnv() },
      runtime.sessionID,
    ),
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
    root ?? runtime.directory,
  );
}
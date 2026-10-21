import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { ASSOCIATE_AGENT_ID, associateAgentConfig } from "./inline";

/**
 * Installing the associate agent into the host's own config.
 *
 * The plugin's `config` hook registers the agent, and that works when the
 * plugin is loaded. It did not work in one host instance -- the hook's
 * mutation was absent from `/config` and the agent was missing from `/agent`,
 * while the plugin itself loaded without an error. Whatever the cause, the
 * dependency was the problem: the inline path required a plugin to be
 * present, loadable, and honoured, in every host instance.
 *
 * The agent does not need a plugin. It is a static block in the host's
 * config, so it is written there, and every instance gets it -- desktop,
 * standalone, sandboxed -- because it is read from the config file rather
 * than from a hook.
 */

export interface ConfigLocation {
  path: string;
  existed: boolean;
}

/**
 * Where the host keeps its config.
 *
 * XDG_CONFIG_HOME is the base, and the flatpak desktop app points it at its
 * own sandbox. An explicit override wins, because the desktop's config lives
 * somewhere a plain shell would not guess.
 */
export function findConfig(explicit?: string): ConfigLocation {
  const candidates = [
    explicit,
    process.env.OPENCODE_CONFIG_PATH,
    process.env.OPENCODE_CUBICORE_CONFIG,
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.json") : undefined,
    join(homedir(), ".config", "opencode", "opencode.json"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);

  // An explicit path is explicit. Falling through to auto-detection would
  // write to some other file than the one the caller named.
  const explicitPath = explicit ?? process.env.OPENCODE_CONFIG_PATH ?? process.env.OPENCODE_CUBICORE_CONFIG;
  if (explicitPath) return { path: explicitPath, existed: existsSync(explicitPath) };

  for (const path of candidates) {
    if (existsSync(path)) return { path, existed: true };
  }

  // Nothing exists yet. Write to the XDG location, which is the convention.
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return { path: join(base, "opencode", "opencode.json"), existed: false };
}

export interface InstallResult {
  path: string;
  wrote: boolean;
  changed: boolean;
  reason?: string;
}

/**
 * Add the associate agent to the host config, preserving everything else.
 *
 * The prompt is written back on every run so an update to the associate
 * instructions reaches hosts that already have the agent.
 */
export function installAgent(explicitPath?: string): InstallResult {
  const location = findConfig(explicitPath);
  const wanted = associateAgentConfig();

  let config: Record<string, unknown> = {};
  if (location.existed) {
    try {
      config = JSON.parse(readFileSync(location.path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      return {
        path: location.path,
        wrote: false,
        changed: false,
        reason: `Could not parse ${location.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const agents = (config.agent ?? {}) as Record<string, unknown>;
  const before = JSON.stringify(agents[ASSOCIATE_AGENT_ID] ?? null);
  const after = JSON.stringify(wanted);

  if (before === after && location.existed) {
    return { path: location.path, wrote: false, changed: false, reason: "already up to date" };
  }

  agents[ASSOCIATE_AGENT_ID] = wanted;
  config.agent = agents;

  mkdirSync(dirname(location.path), { recursive: true });
  writeFileSync(location.path, `${JSON.stringify(config, null, 2)}\n`);

  return { path: location.path, wrote: true, changed: true };
}

/**
 * Is the associate agent present in the host's agent list?
 *
 * The dispatch blueprint is useless without it: the host's task tool would
 * reject every call, and the run would fall back to sessions without saying
 * why. So this is checked before briefs are written, not after six failed
 * calls.
 */
export async function agentAvailable(
  client: { agent?: { list(args?: { query?: { directory?: string } }): Promise<{ data?: unknown }> } },
  directory: string,
): Promise<{ present: boolean; agents: string[] }> {
  try {
    const result = await client.agent?.list({ query: { directory } });
    const list = (result?.data ?? []) as Array<{ name?: string }>;
    const agents = list.map((a) => a.name ?? "").filter(Boolean);
    return { present: agents.includes(ASSOCIATE_AGENT_ID), agents };
  } catch {
    return { present: false, agents: [] };
  }
}

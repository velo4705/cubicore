/**
 * Host-tool inventory — what THIS host has declared as MCPs, not what it
 * might theoretically support.
 *
 * Plan-time principle (now enforced in the planner prompt):
 *   "If the brief names any external tool, use the one that exists in the
 *    installed MCP list. Otherwise, report the issue and suggest what to install."
 *
 * That requires the agent to be able to read, at plan time, exactly what the
 * host has. This module reads the host's config read-only and reports it.
 * It never spawns, installs, or probes anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HostTool {
  /** The server key, e.g. "playwright" or "godot-mcp". */
  name: string;
  /** remote | local */
  type: string;
  /** Local command or remote URL — always printable, never a secret. */
  commandOrUrl: string;
  /** The driver token extracted from the server name (e.g. "godot" from "godot-mcp"). */
  baseName: string;
}

/** Locate the host's opencode.json without spawning anything. */
export function findHostConfig(): string | null {
  const candidates = [
    process.env.OPENCODE_CONFIG_PATH,
    process.env.OPENCODE_CUBICORE_CONFIG,
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "opencode", "opencode.json") : undefined,
    process.env.HOME ? join(process.env.HOME, ".config", "opencode", "opencode.json") : undefined,
    process.env.HOME ? join(process.env.HOME, ".var", "app", "ai.opencode.desktop", "config", "opencode", "opencode.json") : undefined,
    process.env.HOME ? join(process.env.HOME, ".var", "app", "ai.opencode.opencode", "config", "opencode", "opencode.json") : undefined,
  ];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

function baseName(name: string): string {
  return name.replace(/-mcp$/, "").replace(/[^\w]/g, "-").toLowerCase();
}

/** Read the host's declared MCP servers at an exact path. Empty on any failure — never throws. */
export function readHostToolsAt(path: string): HostTool[] {
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as {
      mcp?: Record<string, { type?: string; command?: string[]; url?: string }>;
      servers?: Record<string, { type?: string; command?: string[]; url?: string }>;
    };
    const map = { ...(d.mcp ?? {}), ...(d.servers ?? {}) };
    return Object.entries(map).map(([name, cfg]) => {
      const cmd = cfg.command ? cfg.command.join(" ") : cfg.url ?? "?";
      return { name, type: cfg.type ?? "?", commandOrUrl: cmd, baseName: baseName(name) };
    });
  } catch {
    return [];
  }
}

/** Read the host's declared MCP servers. Falls back to the host's resolved config; never throws. */
export function readHostTools(): HostTool[] {
  const cfg = findHostConfig();
  return cfg ? readHostToolsAt(cfg) : [];
}

/** Match names of the form `foo-mcp` against text. Case-insensitive. */
export function hostsMatching(tools: readonly HostTool[], text: string): HostTool[] {
  const body = text.toLowerCase();
  const tokens = new Set(body.split(/[^a-z0-9]+/i).filter((t) => t.length > 2));
  return tools.filter((t) => tokens.has(t.baseName));
}

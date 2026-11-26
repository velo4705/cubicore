/**
 * Host registry — the boundary for portability.
 *
 * This does not pretend Cubicore already runs on every host. It records where
 * each host actually keeps MCP servers, checks whether Cubicore is registered
 * there, and declares the limits that must be solved by an adapter before
 * dispatch can run on that host. OpenCode is the only verified runtime today.
 *
 * Config locations are taken from the hosts' own documentation:
 * - Claude Code: ~/.claude.json (`mcpServers`) and project `.mcp.json`.
 * - Codex CLI: config.toml (`[mcp_servers.<name>]`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseJsonc } from "../install/jsonc";

export type HostId = "opencode" | "claude-code" | "codex";

export interface HostRegistration {
  id: HostId;
  label: string;
  /** Config paths checked for this host, in precedence order. */
  configPaths: readonly string[];
  /** Canonical command a founder would use to add the Cubicore MCP. */
  addCommand: string;
  /** What an adapter still has to prove before dispatch is supported. */
  limits: readonly string[];
}

export interface HostDetection {
  id: HostId;
  label: string;
  installed: boolean;
  registered: boolean;
  configFile?: string;
  limits: readonly string[];
}

function configPaths(home: string, directory?: string): Record<HostId, string[]> {
  return {
    opencode: [
      join(home, ".config", "opencode", "opencode.json"),
      join(home, ".var", "app", "ai.opencode.opencode", "config", "opencode", "opencode.json"),
    ],
    "claude-code": [
      join(home, ".claude.json"),
      ...(directory ? [join(directory, ".mcp.json")] : []),
    ],
    codex: [
      join(home, ".codex", "config.toml"),
    ],
  };
}

export function hostRegistrations(home: string, directory?: string): HostRegistration[] {
  const paths = configPaths(home, directory);
  return [
    {
      id: "opencode",
      label: "OpenCode",
      configPaths: paths.opencode,
      addCommand: "npx cubicore@latest setup",
      limits: [],
    },
    {
      id: "claude-code",
      label: "Claude Code",
      configPaths: paths["claude-code"],
      addCommand: 'claude mcp add cubicore -- npx -y cubicore@latest',
      limits: [
        "no verified child-session or sub-agent adapter yet",
        "tool permissions and shell isolation not verified on this host",
        "lifecycle stream and cancel path not verified",
      ],
    },
    {
      id: "codex",
      label: "Codex CLI",
      configPaths: paths.codex,
      addCommand: "codex mcp add cubicore -- npx -y cubicore@latest",
      limits: [
        "no verified child-session or sub-agent adapter yet",
        "config format is TOML, not the JSON/JSONC the installer writes",
        "lifecycle stream and cancel path not verified",
      ],
    },
  ];
}

function hasJsonMcp(raw: string, container: string, key: string): boolean {
  try {
    const parsed = parseJsonc(raw) as Record<string, unknown>;
    const section = parsed[container] as Record<string, unknown> | undefined;
    if (section && key in section) return true;
    const projects = parsed.projects as Record<string, { mcpServers?: Record<string, unknown> }> | undefined;
    if (container === "mcpServers") {
      return Object.values(projects ?? {}).some((p) => p?.mcpServers && key in p.mcpServers);
    }
    return false;
  } catch {
    return false;
  }
}

function hasTomlMcp(raw: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\[mcp_servers\\.(?:"${escaped}"|${escaped})\\]`, "m").test(raw);
}

export function detectHosts(env: Record<string, string | undefined> = process.env, directory = process.cwd()): HostDetection[] {
  const home = env.HOME ?? join(directory, ".home");
  return hostRegistrations(home, directory).map((host) => {
    for (const configFile of host.configPaths) {
      if (!existsSync(configFile)) continue;
      try {
        const raw = readFileSync(configFile, "utf8");
        const registered = host.id === "codex"
          ? hasTomlMcp(raw, "cubicore")
          : hasJsonMcp(raw, host.id === "opencode" ? "mcp" : "mcpServers", "cubicore");
        return {
          id: host.id,
          label: host.label,
          installed: true,
          registered,
          configFile,
          limits: host.limits,
        };
      } catch {
        return { id: host.id, label: host.label, installed: true, registered: false, configFile, limits: host.limits };
      }
    }
    return { id: host.id, label: host.label, installed: false, registered: false, limits: host.limits };
  });
}

export function renderHosts(hosts: readonly HostDetection[]): string[] {
  return hosts.map((h) => {
    const state = !h.installed ? "not installed" : h.registered ? "Cubicore registered" : "installed, no Cubicore entry";
    const limits = h.limits.length > 0 ? `; limits: ${h.limits.join(", ")}` : "";
    return `${h.label}: ${state}${h.configFile ? ` (${h.configFile})` : ""}${limits}`;
  });
}

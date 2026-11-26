import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectHosts, hostRegistrations, renderHosts } from "../../src/adapters/hosts";

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "cubicore-hosts-"));
  mkdirSync(join(dir, ".config", "opencode"), { recursive: true });
  mkdirSync(join(dir, ".codex"), { recursive: true });
  return dir;
}

describe("host registry", () => {
  test("declares real config locations and honest limits", () => {
    const hosts = hostRegistrations("/home/founder");
    expect(hosts.map((h) => h.id)).toEqual(["opencode", "claude-code", "codex"]);
    expect(hosts.find((h) => h.id === "opencode")?.limits).toEqual([]);
    expect(hosts.find((h) => h.id === "claude-code")?.configPaths[0]).toBe("/home/founder/.claude.json");
    expect(hosts.find((h) => h.id === "codex")?.configPaths[0]).toBe("/home/founder/.codex/config.toml");
    expect(hosts.find((h) => h.id === "codex")?.limits.length).toBeGreaterThan(0);
  });

  test("finds an OpenCode MCP entry", () => {
    const home = tempHome();
    const config = join(home, ".config", "opencode", "opencode.json");
    writeFileSync(config, JSON.stringify({ mcp: { cubicore: { type: "local" } } }));
    const opencode = detectHosts({ HOME: home }, home).find((h) => h.id === "opencode");
    expect(opencode?.installed).toBe(true);
    expect(opencode?.registered).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("finds a Claude Code user-scope entry and a Codex TOML entry", () => {
    const home = tempHome();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { cubicore: { type: "stdio", command: "npx" } } }));
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.cubicore]\ncommand = "npx"\nargs = ["-y", "cubicore"]\n');
    const hosts = detectHosts({ HOME: home }, home);
    expect(hosts.find((h) => h.id === "claude-code")?.registered).toBe(true);
    expect(hosts.find((h) => h.id === "codex")?.registered).toBe(true);
    expect(renderHosts(hosts).some((line) => line.includes("limits:"))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("does not claim a host is installed when no config exists", () => {
    const home = tempHome();
    const hosts = detectHosts({ HOME: home }, home);
    expect(hosts.find((h) => h.id === "claude-code")?.installed).toBe(false);
    expect(hosts.find((h) => h.id === "codex")?.installed).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

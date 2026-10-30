#!/usr/bin/env bun
/**
 * Cubicore CLI — one-command installation for OpenCode.
 *
 * Usage:
 *   npx cubicore           # interactive install: MCP server + agents
 *   npx cubicore install   # same as above
 *   npx cubicore --help    # show help
 *
 * This is the entry point for people who cannot (or do not want to) manually
 * edit opencode.json. It writes the MCP server entry, installs the associate
 * agents, and tells the founder to restart OpenCode.
 */

import { installAgent } from "./mcp/install";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_PATH = join(CONFIG_DIR, "opencode.json");

interface OpencodeConfig {
  mcp?: Record<string, { type: string; command: string[]; environment?: Record<string, string> }>;
  agent?: Record<string, unknown>;
  plugin?: string[];
  [key: string]: unknown;
}

function readConfig(path: string): OpencodeConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OpencodeConfig;
  } catch {
    return null;
  }
}

function writeConfig(path: string, config: OpencodeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function findBun(): string[] {
  // Prefer the bun binary found on PATH; fall back to common locations.
  const bun = process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bun") : "bun";
  return [bun];
}

function mcpCommand(scriptPath: string): string[] {
  const bun = findBun();
  return [...bun, scriptPath];
}

function installMcpServer(scriptPath: string): { changed: boolean; path: string } {
  const config = readConfig(CONFIG_PATH) ?? {};
  const mcp = config.mcp ?? {};

  const existing = mcp.cubicore;
  const desired = {
    type: "local",
    command: mcpCommand(scriptPath),
    environment: { PATH: `${process.env.BUN_INSTALL ?? ""}:${process.env.PATH ?? ""}` },
  };

  const existingStr = existing ? JSON.stringify(existing) : "";
  const desiredStr = JSON.stringify(desired);

  if (existingStr === desiredStr) {
    return { changed: false, path: CONFIG_PATH };
  }

  mcp.cubicore = desired;
  config.mcp = mcp;
  writeConfig(CONFIG_PATH, config);
  return { changed: true, path: CONFIG_PATH };
}

function printHelp(): void {
  console.log(`
Cubicore — Multi-Agent Factory System for OpenCode

Usage:
  npx cubicore           Install Cubicore MCP server and agents into OpenCode
  npx cubicore install   Same as above
  npx cubicore --help    Show this help

After installation, restart OpenCode and type:
  /cubicore:plan

For manual installation, clone the repository and register the MCP server
in ~/.config/opencode/opencode.json pointing at src/mcp/main.ts.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("install") || args.length === 0) {
    // Resolve the absolute path to the MCP server entry point.
    // When run via npx, __filename is the compiled binary in the npx cache.
    const scriptPath = join(dirname(__filename), "mcp", "main.ts");

    console.log("Cubicore installer\n");

    // 1. Install MCP server into opencode.json
    const mcpResult = installMcpServer(scriptPath);
    if (mcpResult.changed) {
      console.log(`✓ MCP server registered in ${mcpResult.path}`);
    } else {
      console.log(`– MCP server already configured in ${mcpResult.path}`);
    }

    // 2. Install associate agents
    const agentResult = installAgent(CONFIG_PATH);
    if (agentResult.wrote) {
      console.log(`✓ Cubicore agents installed in ${agentResult.path}`);
      if (agentResult.maxSteps) {
        console.log(`  Primary agent bounded to ${agentResult.maxSteps} steps`);
      }
    } else if (agentResult.changed) {
      console.log(`– Cubicore agents updated in ${agentResult.path}`);
    } else {
      console.log(`– Cubicore agents already up to date in ${agentResult.path}`);
    }

    console.log(`
Installation complete. Restart OpenCode so it picks up the MCP server and agents.

Then in any project directory, type:
  /cubicore:plan

To verify the server is running, run:
  /cubicore:status
`);
    return;
  }

  printHelp();
}

main().catch((error) => {
  console.error(`Cubicore install failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

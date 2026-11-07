#!/usr/bin/env node
/**
 * Cubicore CLI — the global installer for OpenCode.
 *
 *   npx cubicore@latest setup
 *
 * Prints a banner, asks which OpenCode to install into (native CLI/Desktop
 * by default, or the Flatpak build on Linux), and registers the Cubicore
 * MCP server and agents in that variant's global config. Everything is
 * written to user-scoped, machine-global locations — never to a project.
 *
 * If the OpenCode variant's config directory is not present, the script
 * says plainly that OpenCode is missing and stops. Nothing is written.
 *
 * Flags for automation:
 *   --native     install into the native OpenCode config (the default)
 *   --flatpak    install into the Flatpak OpenCode config (Linux only)
 *   --yes, -y    non-interactive; accept the default target
 *   --help, -h   show usage
 *   --version,-v show version
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import { installAgent } from "./mcp/install";
import { parseJsonc } from "./install/jsonc";
import {
  dataDir,
  resolveBun,
  resolveTargets,
  type InstallTarget,
  type ResolveOptions,
} from "./install/targets";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const AMBER = "\x1b[38;5;117m";  // baby blue / light sky
const WHITE = "\x1b[97m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (!process.stdout.isTTY) return false;
  if ((process.env.TERM ?? "") === "dumb") return false;
  return true;
}

function paint(color: string, text: string): string {
  return useColor() ? `${color}${text}${RESET}` : text;
}

const GLYPHS: Record<string, string[]> = {
  C: ["█████", "█    ", "█    ", "█    ", "█████"],
  U: ["█   █", "█   █", "█   █", "█   █", " ███ "],
  B: ["████ ", "█   █", "████ ", "█   █", "████ "],
  I: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  R: ["████ ", "█   █", "████ ", "█ █  ", "█  █ "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
};

function banner(version: string): string {
  const rows: string[] = [];
  for (let row = 0; row < 5; row += 1) {
    rows.push(
      [..."CUBICORE"]
        .map((ch) => GLYPHS[ch]?.[row] ?? "     ")
        .join(" ")
        .replace(/\s+$/, ""),
    );
  }
  const art = rows.map((line) => paint(AMBER, line)).join("\n");
  const tagline = paint(WHITE, "  Build exactly what the founder asked for");
  const subtitle = paint(DIM, `  Global installer for OpenCode · v${version}`);
  return `\n${art}\n\n${tagline}\n${subtitle}\n`;
}

function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

interface CliArgs {
  help: boolean;
  version: boolean;
  yes: boolean;
  target: "native" | "flatpak" | null;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const args: CliArgs = { help: false, version: false, yes: false, target: null };
  for (const arg of argv) {
    switch (arg) {
      case "setup":
      case "install":
        // Positional subcommand; the bin is the installer, so this is a no-op.
        break;
      case "--native":
        if (args.target === "flatpak") return { error: "Pass either --native or --flatpak, not both." };
        args.target = "native";
        break;
      case "--flatpak":
        if (args.target === "native") return { error: "Pass either --native or --flatpak, not both." };
        args.target = "flatpak";
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      default:
        return { error: `Unknown argument: ${arg}` };
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
${paint(AMBER, "CUBICORE")} — global installer for OpenCode

Usage:
  npx cubicore@latest setup          Interactive install (default)
  npx cubicore@latest setup --native     Install into the native OpenCode (CLI/Desktop)
  npx cubicore@latest setup --flatpak    Install into the Flatpak OpenCode (Linux only)
  npx cubicore@latest setup --yes        Non-interactive; use the native default
  cubicore --help                     Show this help

What it does:
  · Registers the Cubicore MCP server in the chosen OpenCode's global config
  · Copies the MCP runtime once to a user-global location (~/.local/share/cubicore)
  · Installs the cubicore-associate / cubicore-research agents
  · Never writes into a project; never touches other OpenCode variants

If the chosen OpenCode's config directory is missing, nothing is written and
the script says so. After a successful install, restart OpenCode fully.
`);
}

/** Atomic write of a text file: temp file in the same directory, then rename. */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

interface OpencodeConfig {
  mcp?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Read the existing config. Plain JSON first; if that fails and the file is a
 * .jsonc, strip comments/trailing commas string-aware and parse that.
 * Returns null when the file does not exist. Throws on unreadable content.
 */
function readConfig(path: string): { config: OpencodeConfig; wasJsonc: boolean } {
  const raw = readFileSync(path, "utf8");
  try {
    return { config: JSON.parse(raw) as OpencodeConfig, wasJsonc: false };
  } catch (error) {
    if (!path.endsWith(".jsonc")) {
      throw new Error(
        `Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return { config: parseJsonc(raw) as OpencodeConfig, wasJsonc: true };
    } catch (jsoncError) {
      throw new Error(
        `Could not parse ${path} (tried JSON and JSONC): ${
          jsoncError instanceof Error ? jsoncError.message : String(jsoncError)
        }`,
      );
    }
  }
}

/**
 * The MCP entry we write. OpenCode injects OPENCODE_SERVER_USERNAME /
 * OPENCODE_SERVER_PASSWORD into MCP servers at launch, so credentials never
 * go near the config — and a stale run-specific OPENCODE_PORT is dropped on
 * purpose (the server discovers the ephemeral port itself).
 *
 * PATH is extended only when we resolved an absolute bun binary: desktop
 * instances often launch with a minimal PATH that lacks ~/.bun/bin.
 */
function mcpEntry(command: string[], bunAbsolute: string | null): Record<string, unknown> {
  const environment: Record<string, string> = {};
  const fallbackPath =
    platform() === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32")
      : "/usr/local/bin:/usr/bin:/bin";
  const current = process.env.PATH ?? "";
  if (bunAbsolute) {
    const bunDir = dirname(bunAbsolute);
    environment.PATH = current.split(delimiter).includes(bunDir)
      ? current
      : current
        ? `${bunDir}${delimiter}${current}`
        : bunDir;
  } else {
    environment.PATH = current || fallbackPath;
  }
  return {
    type: "local",
    enabled: true,
    command,
    environment,
  };
}

function copyRuntimeBundle(destDir: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = join(here, "mcp-main.js");
  if (!existsSync(source)) {
    throw new Error(
      `The MCP bundle is missing next to this installer (${source}). ` +
        `If you are developing Cubicore, run \`bun run build\` first.`,
    );
  }
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "mcp-main.js");
  copyFileSync(source, `${dest}.tmp-${process.pid}`);
  renameSync(`${dest}.tmp-${process.pid}`, dest);
  return dest;
}

async function prompt(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().length === 0 ? fallback : answer.trim();
  } finally {
    rl.close();
  }
}

function failMissingTarget(target: InstallTarget): number {
  console.log(
    paint(RED, `\n✗ ${target.label} OpenCode not found`),
  );
  console.log(`
  Cubicore expected the OpenCode configuration directory at:

    ${target.configDir}

  It is not there, which means this OpenCode was not installed — or was not
  installed properly. Install OpenCode from https://opencode.ai, start it once
  so it creates its config, then re-run:

    npx cubicore@latest setup
`);
  // Explicitly per spec: a missing OpenCode is a clean stop, not an error.
  return 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\nRun \`cubicore --help\` for usage.`);
    process.exit(1);
    return;
  }
  const version = packageVersion();

  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.version) {
    console.log(version);
    return;
  }

  console.log(banner(version));

  const resolveOpts: ResolveOptions = {
    platform: platform(),
    env: process.env,
    home: homedir(),
    exists: existsSync,
  };
  const targets = resolveTargets(resolveOpts);

  // Choose the target: explicit flag > interactive prompt > native default.
  let target: InstallTarget;
  if (parsed.target) {
    const chosen = targets.find((t) => t.id === parsed.target);
    if (!chosen) {
      console.error(
        paint(RED, `\n✗ --${parsed.target} is not available on this system.`) +
          " The Flatpak build of OpenCode only exists on Linux; use --native.",
      );
      process.exit(1);
      return;
    }
    target = chosen;
    console.log(`  Target: ${target.label} (from --${target.id})\n  ${target.configFile}\n`);
  } else if (!process.stdin.isTTY || parsed.yes) {
    target = targets[0] as InstallTarget;
    console.log(
      `  ${DIM}No terminal to ask on${parsed.yes ? " and --yes was given" : ""}; ` +
        `using the default (${target.label}).\n  Pass --flatpak to target the Flatpak build instead.${RESET}\n`,
    );
  } else {
    console.log(`  ${BOLD}Where do you want Cubicore installed?${RESET}\n`);
    targets.forEach((t, index) => {
      const marker = index === 0 ? paint(CYAN, " (default)") : "";
      console.log(`    ${index + 1}) ${t.label}${marker}`);
      console.log(`       ${t.description}`);
      console.log(`       ${paint(DIM, t.configFile)}\n`);
    });
    const answer = await prompt(`  Select [1${targets.length > 1 ? `-${targets.length}` : ""}] (default 1): `, "1");
    const choice = Number.parseInt(answer, 10);
    const chosen = targets[Number.isFinite(choice) ? choice - 1 : 0];
    target = chosen ?? (targets[0] as InstallTarget);
  }

  // The one guard the spec demands: no OpenCode, no installation, clean stop.
  if (!existsSync(target.configDir)) {
    process.exit(failMissingTarget(target));
    return;
  }

  // 1. Resolve bun and copy the MCP runtime to a user-global location.
  const bundleDir = dataDir(resolveOpts);
  let bundlePath: string;
  try {
    bundlePath = copyRuntimeBundle(bundleDir);
    console.log(paint(GREEN, "  ✓") + ` MCP runtime copied to ${paint(DIM, bundlePath)}`);
  } catch (error) {
    console.error(paint(RED, `\n✗ ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
    return;
  }

  const bun = resolveBun(resolveOpts);
  const bunCommand = bun.command(bundlePath);
  if (bun.absolute) {
    console.log(paint(GREEN, "  ✓") + ` bun resolved at ${paint(DIM, bun.absolute)}`);
  } else {
    console.log(
      paint(DIM, "  · bun not found on this machine — the MCP will run through") +
        `\n${paint(DIM, "    `npx --yes bun` instead. Install bun (https://bun.sh) for instant starts.")}`,
    );
  }

  // 2. Merge the MCP entry into the chosen OpenCode's global config.
  const configPath = target.configFile;
  const existed = existsSync(configPath);
  let config: OpencodeConfig = {};
  let wasJsonc = false;
  if (existed) {
    try {
      const read = readConfig(configPath);
      config = read.config;
      wasJsonc = read.wasJsonc;
    } catch (error) {
      console.error(
        paint(RED, `\n✗ ${error instanceof Error ? error.message : String(error)}`) +
          `\n  Refusing to touch the file. Fix the JSON, then re-run setup.`,
      );
      process.exit(1);
      return;
    }
    // Back the file up once before rewriting it.
    try {
      copyFileSync(configPath, `${configPath}.cubicore.bak`);
    } catch {
      // A backup is best-effort; failing to copy must not block a safe write.
    }
  }

  const mcp = { ...(config.mcp ?? {}) };
  mcp.cubicore = mcpEntry(bunCommand, bun.absolute);
  config.mcp = mcp;

  try {
    atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(
      paint(GREEN, "  ✓") +
        ` MCP server registered in ${paint(DIM, configPath)}` +
        (wasJsonc ? paint(DIM, " (comments were stripped; values preserved; backup at ") + paint(DIM, `${configPath}.cubicore.bak)`) : ""),
    );
  } catch (error) {
    console.error(
      paint(RED, `\n✗ Could not write ${configPath}: ${error instanceof Error ? error.message : String(error)}`),
    );
    process.exit(1);
    return;
  }

  // 3. Install the associate agents into the same config.
  const agentResult = installAgent(configPath);
  if (agentResult.wrote || agentResult.changed) {
    console.log(paint(GREEN, "  ✓") + ` Cubicore agents installed in ${paint(DIM, agentResult.path)}`);
    if (agentResult.maxSteps) {
      console.log(`    ${paint(DIM, `primary agent bounded to ${agentResult.maxSteps} steps`)}`);
    }
  } else if (agentResult.reason === "already up to date") {
    console.log(paint(GREEN, "  ✓") + " Cubicore agents already up to date");
  } else {
    console.error(
      paint(RED, `\n✗ Agents could not be installed: ${agentResult.reason ?? "unknown reason"}`),
    );
    process.exit(1);
    return;
  }

  console.log(`
${paint(GREEN, "Installation complete.")} Restart OpenCode fully for the changes to take effect,
then type ${paint(CYAN, "/cubicore:plan-demo")} in any project directory.

Re-running ${paint(DIM, "npx cubicore@latest setup")} updates the MCP runtime and refreshes the config entry.
`);
}

main().catch((error) => {
  console.error(
    paint(RED, `\nCubicore install failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  process.exit(1);
});

/**
 * Uninstall — remove exactly the marks `setup` wrote, nothing else.
 *
 * The hard part is that `setup` targets ONE OpenCode variant per run (native
 * or Flatpak), so a machine can have Cubicore installed in both. Uninstall
 * therefore detects which targets carry our MCP entry and acts on each,
 * unless the founder names one with --native / --flatpak.
 *
 * We remove only Cubicore-owned keys:
 *   - mcp.cubicore
 *   - agent[cubicore-associate], agent[cubicore-research]
 *   - the copied runtime bundle (only when no remaining target uses it)
 *   - the version stamp (.cubicore-version)
 *
 * We NEVER remove: build.maxSteps (could be the founder's), config backups,
 * other MCP servers, other agents, or any project-level file.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseJsonc } from "./jsonc";
import { CUBICORE_AGENT_IDS } from "../mcp/agents";
import {
  resolveTargets,
  dataDir,
  type InstallTarget,
  type ResolveOptions,
} from "./targets";

export interface UninstallResult {
  target: string;
  configFile: string;
  removed: string[];
  /** True when this target's config was changed. */
  changed: boolean;
  reason?: string;
}

interface OpencodeConfig {
  mcp?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  [key: string]: unknown;
}

function readConfig(path: string): { config: OpencodeConfig; wasJsonc: boolean } | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  try {
    return { config: JSON.parse(raw) as OpencodeConfig, wasJsonc: false };
  } catch {
    if (!path.endsWith(".jsonc")) throw new Error(`Could not parse ${path}`);
    return { config: parseJsonc(raw) as OpencodeConfig, wasJsonc: true };
  }
}

function hasCubicore(config: OpencodeConfig): boolean {
  const mcp = config.mcp && typeof config.mcp === "object"
    ? Object.prototype.hasOwnProperty.call(config.mcp, "cubicore")
    : false;
  const agents = config.agent && typeof config.agent === "object"
    ? CUBICORE_AGENT_IDS.some((id) => Object.prototype.hasOwnProperty.call(config.agent ?? {}, id))
    : false;
  return mcp || agents;
}

/** Which targets actually carry a Cubicore mark right now? */
export function detectInstalledTargets(options: ResolveOptions = {}): InstallTarget[] {
  return resolveTargets(options).filter((target) => {
    try {
      const parsed = readConfig(target.configFile);
      return parsed !== null && hasCubicore(parsed.config);
    } catch {
      return false;
    }
  });
}

function removeFromConfig(target: InstallTarget): UninstallResult {
  const base: UninstallResult = {
    target: target.id,
    configFile: target.configFile,
    removed: [],
    changed: false,
  };
  let parsed: ReturnType<typeof readConfig>;
  try {
    parsed = readConfig(target.configFile);
  } catch (error) {
    return { ...base, reason: `could not read config: ${String(error).slice(0, 160)}` };
  }
  if (!parsed) return { ...base, reason: "no config file at this target" };
  if (!hasCubicore(parsed.config)) return { ...base, reason: "no Cubicore entry in this config" };

  const config = parsed.config;
  // Keep backups — they are founder recovery data, not our delete target.
  try { copyFileSync(target.configFile, `${target.configFile}.cubicore-uninstall.bak`); } catch { /* best effort */ }

  if (config.mcp && typeof config.mcp === "object" && "cubicore" in config.mcp) {
    delete config.mcp.cubicore;
    base.removed.push("mcp.cubicore");
  }
  if (config.agent && typeof config.agent === "object") {
    for (const id of CUBICORE_AGENT_IDS) {
      if (Object.prototype.hasOwnProperty.call(config.agent, id)) {
        delete config.agent[id];
        base.removed.push(`agent.${id}`);
      }
    }
  }
  // build.maxSteps is deliberately left alone — the founder may have set it.
  if (base.removed.length > 0) {
    writeFileSync(target.configFile, `${JSON.stringify(config, null, 2)}\n`);
    base.changed = true;
  }

  // Version stamp lives beside the config; safe to remove.
  const stamp = join(dirname(target.configFile), ".cubicore-version");
  if (existsSync(stamp)) {
    try { unlinkSync(stamp); base.removed.push(".cubicore-version"); } catch { /* best effort */ }
  }
  return base;
}

/** Remove the bundle only when no other detected target still needs it. */
function maybeRemoveBundle(
  removedTargets: InstallTarget[],
  remainingTargets: InstallTarget[],
  options: ResolveOptions,
): string[] {
  const removed: string[] = [];
  const dir = dataDir(options);
  const bundle = join(dir, "mcp-main.js");
  if (!existsSync(bundle)) return removed;
  // Another target's MCP entry may point at this same bundle path — check
  // its config rather than guessing from target ids.
  const stillUsed = remainingTargets.some((target) => {
    try {
      const parsed = readConfig(target.configFile);
      return parsed !== null && Object.prototype.hasOwnProperty.call(parsed.config.mcp ?? {}, "cubicore");
    } catch {
      return true; // if we cannot tell, keep the bundle
    }
  });
  if (stillUsed) return removed;
  if (removedTargets.length === 0) return removed;
  try {
    unlinkSync(bundle);
    removed.push(bundle);
    // Remove the directory only if empty; never recurse into founder data.
    const entries = readdirSync(dir);
    if (entries.length === 0) rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
  return removed;
}

export function uninstall(options: ResolveOptions = {}, only?: "native" | "flatpak"): {
  targets: UninstallResult[];
  bundleRemoved: string[];
} {
  const detected = detectInstalledTargets(options);
  const chosen = only ? detected.filter((t) => t.id === only) : detected;
  const results = chosen.map(removeFromConfig);
  const changedTargets = chosen.filter((_, i) => results[i]?.changed);
  const remaining = detected.filter((t) => !changedTargets.some((c) => c.id === t.id));
  const bundleRemoved = maybeRemoveBundle(changedTargets, remaining, options);
  return { targets: results, bundleRemoved };
}

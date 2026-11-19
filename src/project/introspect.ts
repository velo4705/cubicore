/**
 * Project introspection — record which native bits are already present on
 * this host so downstream dispatchers never re-install what the host can
 * already build. Nothing here contacts the network; everything is a local
 * filesystem-and-PATH read.
 *
 * The file that holds this snapshot is read via `host_tools` and inside the
 * agent's briefs so associates know, ahead of time, whether e.g. a Playwright
 * chromium exists and where; or if `sharp` compiled into node_modules.
 *
 * The snapshot refreshes opportunistically on every `prepare` call; callers
 * with stale snapshots should treat values as hints, not ground truth.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ProjectHostState {
  /** Exact file this was written from — consumers read this snapshot's mtime. */
  writtenAt: string;
  /** node version that ran Cubicore, not necessarily the app's runtime. */
  node: string;
  /** npm version if globally resolvable; null if not. */
  npm: string | null;
  /** Platform the snapshot was made on — the app may be cross-compiled. */
  platform: string;
  /** Whether node_modules exists in the probed directory. */
  nodeModulesPresent: boolean;
}

export interface ProjectStateSnapshot {
  schemaVersion: 1;
  host: ProjectHostState;
  /** Native deps declared in package.json AND present in node_modules. */
  nativeDeps: Record<string, NativeDepProbe>;
  /** Playwright browser cache presence — especially expensive to rediscover. */
  playwrightBrowsers: Array<{ name: string; revision: number | null; path: string }>;
}

export interface NativeDepProbe {
  declared: boolean;
  installed: boolean;
}

const INTROS: string[] = ["sharp", "better-sqlite3", "playwright", "@playwright/test", "esbuild", "turbo"];

function probeCmd(command: string, args: string[]): string | null {
  try {
    const out = execFileSync(command, args, { encoding: "utf8", timeout: 4000, maxBuffer: 131072 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function readPackage(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function checkDep(dir: string, name: string): NativeDepProbe {
  let declared = false;
  let installed = false;
  try {
    const pkg = readPackage(dir);
    const deps = pkg ? Object.assign({}, pkg.dependencies, pkg.devDependencies) : {};
    declared = typeof deps === "object" && deps !== null && Object.prototype.hasOwnProperty.call(deps, name);
  } catch { /* absent */ }
  try {
    const modDir = join(dir, "node_modules", name);
    installed = existsSync(modDir) && statSync(modDir).isDirectory();
  } catch { /* absent */ }
  return { declared, installed };
}

function findPlaywrightCache(): Array<{ name: string; revision: number | null; path: string }> {
  const out: Array<{ name: string; revision: number | null; path: string }> = [];
  // XDG_DATA_HOME wins if set — Flatpak prefixes XDG vars, so this catches it.
  const candidates: string[] = [];
  for (const base of [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.XDG_DATA_HOME,
    join(process.env.HOME ?? "/", ".cache"),
    join(process.env.HOME ?? "/", ".var/app/ai.opencode.opencode/cache"),
  ]) {
    if (base) candidates.push(base.endsWith("ms-playwright") ? base : join(base, "ms-playwright"));
  }
  for (const root of candidates) {
    try {
      const entries = readdirSync(root) as string[];
      for (const entry of entries) {
        const match = /^(chromium_headless_shell|chromium|firefox|webkit)-(\d+)$/i.exec(entry);
        if (!match) continue;
        const revision = Number.parseInt(match[2] ?? "", 10);
        out.push({
          name: match[1] ?? "unknown",
          revision: Number.isFinite(revision) ? revision : null,
          path: join(root, entry),
        });
      }
    } catch { /* cache absent on this host */ }
  }
  // Dedupe by name+revision, preferring the first found
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.name}:${item.revision}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function introspectProject(dir: string): ProjectStateSnapshot {
  const host: ProjectHostState = {
    writtenAt: new Date().toISOString(),
    node: process.version,
    npm: probeCmd("npm", ["--version"]),
    platform: process.platform,
    nodeModulesPresent: (() => {
      try {
        return existsSync(join(dir, "node_modules")) && statSync(join(dir, "node_modules")).isDirectory();
      } catch {
        return false;
      }
    })(),
  };

  const nativeDeps: Record<string, NativeDepProbe> = {};
  for (const name of INTROS) nativeDeps[name] = checkDep(dir, name);

  const playwrightBrowsers = findPlaywrightCache();

  return { schemaVersion: 1, host, nativeDeps, playwrightBrowsers };
}

/** Write the snapshot to <dir>/.cubicore-state.json — additive, never blocks. */
export function writeStateSnapshot(dir: string, snapshot?: ProjectStateSnapshot): string | null {
  const snap = snapshot ?? introspectProject(dir);
  const path = join(dir, ".cubicore-state.json");
  try {
    writeFileSync(path, JSON.stringify(snap, null, 2) + "\n");
    return path;
  } catch (error) {
    process.stderr.write(`[cubicore] could not write ${path}: ${String(error).slice(0, 200)}\n`);
    return null;
  }
}

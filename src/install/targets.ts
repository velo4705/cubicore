/**
 * Where OpenCode keeps its global configuration, per platform.
 *
 * The installer must not hard-code one machine's layout. OpenCode's own
 * documentation settles the locations:
 *
 *   Native (CLI / Desktop)  ~/.config/opencode/opencode.json(c)
 *                           (on Windows: %USERPROFILE%\.config\opencode)
 *   Flatpak (Linux only)    ~/.var/app/ai.opencode.opencode/config/opencode/opencode.json(c)
 *
 * Three environment variables change the native picture, and OpenCode
 * honours them itself, so we do too:
 *
 *   OPENCODE_CONFIG      a custom config FILE (directory = its parent)
 *   OPENCODE_CONFIG_DIR  a custom config DIRECTORY (searched like the
 *                        standard one, for agents/commands/plugins)
 *   XDG_CONFIG_HOME      base of ~/.config; respected when set
 *
 * Everything here is a pure function of (platform, env, home, exists) so the
 * matrix can be unit-tested from any host.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TargetId = "native" | "flatpak";

export interface InstallTarget {
  id: TargetId;
  /** Short label shown in the interactive menu. */
  label: string;
  /** One-line explanation shown next to the label. */
  description: string;
  /**
   * Directory that must exist for this OpenCode variant to count as
   * installed. The spec is explicit here: if the directory is absent, the
   * user does not have this OpenCode installed (properly), and the script
   * concludes without writing anything.
   */
  configDir: string;
  /** Absolute path of the file we will read and write. */
  configFile: string;
  /** True when this is the Flatpak sandbox build. */
  flatpak: boolean;
}

export interface ResolveOptions {
  /** Defaults to process.platform. */
  platform?: string;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to os.homedir(). */
  home?: string;
  /** Injectable for tests; defaults to fs.existsSync. */
  exists?: (path: string) => boolean;
}

function isSet(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * OpenCode reads both opencode.json and opencode.jsonc (JSON with comments
 * and trailing commas).
 *
 * When both exist we write to opencode.json. This is not guesswork: the
 * Cubicore agents live only in opencode.json on machines whose global
 * config dir carries a 50-byte opencode.jsonc stub, and the host loads them
 * — so the host demonstrably honours opencode.json in that situation. A
 * merge could equally explain it, but json-first is the only choice that
 * cannot leave the install invisible. When only a jsonc exists we write to
 * it (jsonc-first would equally risk silence in the same setup).
 */
function pickConfigFile(configDir: string, exists: (path: string) => boolean): string {
  const json = join(configDir, "opencode.json");
  if (exists(json)) return json;
  const jsonc = join(configDir, "opencode.jsonc");
  if (exists(jsonc)) return jsonc;
  return json;
}

export function resolveNativeTarget(options: ResolveOptions = {}): InstallTarget {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? ((): boolean => false);

  let configDir: string;
  let configFile: string;

  if (isSet(env.OPENCODE_CONFIG)) {
    // An explicit config file wins over every other convention.
    configFile = env.OPENCODE_CONFIG;
    configDir = dirname(configFile);
  } else if (isSet(env.OPENCODE_CONFIG_DIR)) {
    configDir = env.OPENCODE_CONFIG_DIR;
    configFile = pickConfigFile(configDir, exists);
  } else if (isSet(env.XDG_CONFIG_HOME)) {
    configDir = join(env.XDG_CONFIG_HOME, "opencode");
    configFile = pickConfigFile(configDir, exists);
  } else {
    // Every platform OpenCode supports lays the global config out the same
    // way under the user's home. On Windows this resolves to
    // %USERPROFILE%\.config\opencode, matching OpenCode's own docs
    // (WIN+R → %USERPROFILE%\.config\opencode).
    configDir = join(home, ".config", "opencode");
    configFile = pickConfigFile(configDir, exists);
  }

  return {
    id: "native",
    label: "Native (CLI / Desktop)",
    description: "OpenCode installed directly on this machine",
    configDir,
    configFile,
    flatpak: false,
  };
}

/** Flatpak builds only exist on Linux. */
export function resolveFlatpakTarget(options: ResolveOptions = {}): InstallTarget | null {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? ((): boolean => false);
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return null;

  const configDir = join(
    home,
    ".var",
    "app",
    "ai.opencode.opencode",
    "config",
    "opencode",
  );

  return {
    id: "flatpak",
    label: "Flatpak",
    description: "OpenCode as a Flatpak sandbox (Linux only)",
    configDir,
    configFile: pickConfigFile(configDir, exists),
    flatpak: true,
  };
}

/** Every installation target on this platform, native first (the default). */
export function resolveTargets(options: ResolveOptions = {}): InstallTarget[] {
  const targets = [resolveNativeTarget(options)];
  const flatpak = resolveFlatpakTarget(options);
  if (flatpak) targets.push(flatpak);
  return targets;
}

/** Result of looking for a usable bun binary. */
export interface BunResolution {
  /** Absolute path of the bun binary, or null when none was found. */
  absolute: string | null;
  /**
   * argv prefix that can launch the MCP bundle. When no local bun exists
   * this falls back to `npx --yes bun <mcpMainPath>` so a machine with only
   * npm/npx still ends up with a working MCP server.
   */
  command: (mcpMainPath: string) => string[];
}

function bunExecutable(platform: string): string {
  return platform === "win32" ? "bun.exe" : "bun";
}

/**
 * Find bun: an explicit override, BUN_INSTALL, the default install location,
 * platform-conventional prefixes, and finally every directory on PATH.
 *
 * An absolute path matters because OpenCode desktop instances do not
 * inherit a shell PATH — the live config on this machine carried a
 * hand-written PATH for exactly that reason.
 */
export function resolveBun(options: ResolveOptions = {}): BunResolution {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? ((): boolean => false);
  const bun = bunExecutable(platform);

  const candidates: Array<string | undefined> = [
    env.CUBICORE_BUN,
    isSet(env.BUN_INSTALL) ? join(env.BUN_INSTALL, "bin", bun) : undefined,
    join(home, ".bun", "bin", bun),
    platform === "win32" ? undefined : "/usr/local/bin/bun",
    platform === "darwin" ? "/opt/homebrew/bin/bun" : undefined,
  ];

  // Delimit PATH with the target platform's separator, not the host's.
  const pathDelimiter = platform === "win32" ? ";" : ":";
  for (const dir of isSet(env.PATH) ? env.PATH.split(pathDelimiter) : []) {
    if (isSet(dir)) candidates.push(join(dir, bun));
  }

  for (const candidate of candidates) {
    if (isSet(candidate) && exists(candidate)) {
      return { absolute: candidate, command: (mcpMainPath) => [candidate, mcpMainPath] };
    }
  }

  // npm/npx is the one prerequisite every supported machine has by
  // definition (the installer itself arrived through npx), so fall back to
  // running bun through npx rather than failing the whole installation.
  //
  // On Windows npx is a .cmd shim, which OpenCode's spawner cannot launch
  // without cmd.exe in between, so wrap it there.
  return {
    absolute: null,
    command: (mcpMainPath) =>
      platform === "win32"
        ? ["cmd", "/c", "npx", "--yes", "bun", mcpMainPath]
        : ["npx", "--yes", "bun", mcpMainPath],
  };
}

/**
 * Where the MCP runtime bundle is copied to. Copying (instead of pointing at
 * the npx cache) means the OpenCode config never depends on a cache entry
 * surviving — rebundling runs on every `cubicore setup`, which doubles as
 * the upgrade path.
 */
export function dataDir(options: ResolveOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    return join(isSet(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, "AppData", "Local"), "cubicore");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "cubicore");
  }
  return join(isSet(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share"), "cubicore");
}

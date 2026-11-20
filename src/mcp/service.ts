import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Where OpenCode keeps its service credential.
 *
 * An MCP server launched by OpenCode does not receive the password it needs
 * to talk back to the service — the old config worked around this only when
 * the installer had copied the password into `environment` (a leak this
 * rebuild removed). The password lives in the host's own `service.json`.
 *
 * 2026-11-20: the host rotates this file and has moved its location on
 * successive updates. So resolution is NEVER cached: every call re-enumerates
 * candidates and re-reads each file. Callers retry once on HTTP 401 — that is
 * how a mid-session rotation heals without a restart.
 */

export interface CredentialSource {
  /** Which candidate produced the password — named in auth checks, never the secret. */
  label: string;
  password: string;
}

/** Candidate service.json paths, widest plausible set, deduped. */
function credentialPaths(env: Record<string, string | undefined>): string[] {
  const paths: string[] = [];
  const add = (p: string | undefined) => {
    if (p && !paths.includes(p)) paths.push(p);
  };

  if (env.OPENCODE_CONFIG) add(join(dirname(env.OPENCODE_CONFIG), "service.json"));
  if (env.OPENCODE_CONFIG_DIR) add(join(env.OPENCODE_CONFIG_DIR, "service.json"));

  const home = env.HOME ?? homedir();
  add(env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode", "service.json") : undefined);
  add(join(home, ".config", "opencode", "service.json"));
  add(join(home, ".var", "app", "ai.opencode.opencode", "config", "opencode", "service.json"));

  // Flatpak app ids and versioned CLI folders have changed between updates;
  // discover them once per call rather than pinning one spelling forever.
  const flatpakApp = join(home, ".var", "app");
  try {
    for (const entry of readdirSync(flatpakApp)) {
      if (!/opencode/i.test(entry)) continue;
      add(join(flatpakApp, entry, "config", "opencode", "service.json"));
    }
  } catch { /* no Flatpak tree */ }

  return paths;
}

/** Resolve a credential fresh from the env pair first, then every service.json. */
export function resolveCredential(
  env: Record<string, string | undefined> = process.env,
): CredentialSource | undefined {
  const username = env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (password && username) return { label: "environment", password };

  for (const path of credentialPaths(env)) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { password?: unknown };
      if (typeof raw.password === "string" && raw.password.length > 0) {
        return { label: `service.json: ${path}`, password: raw.password };
      }
    } catch {
      // Rotating file — read again next call.
    }
  }
  return undefined;
}

/** Password-only accessor for older call sites. */
export function servicePassword(): string | undefined {
  return resolveCredential()?.password;
}

/** Build a Basic header from a specific credential (used on 401 retries). */
export function basicAuthFor(credential: CredentialSource): string {
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  return `Basic ${btoa(`${username}:${credential.password}`)}`;
}

/**
 * One Basic auth header for every raw /api/* call. Resolves fresh each call —
 * no credential, path, or header is cached anywhere in this module.
 */
export function basicAuthHeader(): string {
  const credential = resolveCredential();
  return credential
    ? basicAuthFor(credential)
    : `Basic ${btoa(`opencode:`)}`;
}

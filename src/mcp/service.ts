import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Where OpenCode keeps its service credential.
 *
 * An MCP server launched by OpenCode does not receive the password it needs
 * to talk back to the service — the old config worked around this only when
 * the installer had copied the password into `environment` (a leak this
 * rebuild removed). The password itself lives in the host's own
 * `service.json`, so the server reads it there with the same precedence the
 * installer uses for the config file. Never logged, never echoed.
 */
export function servicePassword(): string | undefined {
  const env = process.env;
  const candidates: string[] = [];

  if (env.OPENCODE_CONFIG) {
    candidates.push(join(dirname(env.OPENCODE_CONFIG), "service.json"));
  }
  if (env.OPENCODE_CONFIG_DIR) {
    candidates.push(join(env.OPENCODE_CONFIG_DIR, "service.json"));
  }
  const home = env.HOME ?? homedir();
  if (env.XDG_CONFIG_HOME) {
    candidates.push(join(env.XDG_CONFIG_HOME, "opencode", "service.json"));
  } else {
    candidates.push(join(home, ".config", "opencode", "service.json"));
  }
  candidates.push(join(home, ".var", "app", "ai.opencode.opencode", "config", "opencode", "service.json"));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { password?: unknown };
      if (typeof raw.password === "string" && raw.password.length > 0) {
        return raw.password;
      }
    } catch {
      // Unreadable or malformed service.json — try the next candidate.
    }
  }
  return undefined;
}

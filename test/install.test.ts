import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installAgent, findConfig } from "../src/mcp/install";
import { ASSOCIATE_AGENT_ID } from "../src/mcp/inline";

/**
 * The agent lives in the host's own config, not behind a plugin hook.
 *
 * The plugin's config hook registers it, and that works when the plugin is
 * loaded. It did not work in one host instance: the hook's mutation was
 * absent from /config and the agent was missing from /agent, while the
 * plugin itself loaded without an error. Depending on a plugin to exist,
 * load, and be honoured in every host instance is the dependency that broke.
 */

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "cubicore-cfg-"));
  const path = join(root, "opencode.json");
  writeFileSync(path, JSON.stringify({ mcp: { other: { type: "local" } }, plugin: ["x"] }));
  return path;
};

describe("agent install", () => {
  it("adds the associate agent without touching anything else", () => {
    const path = fixture();
    const result = installAgent(path);
    expect(result.wrote).toBe(true);

    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.agent[ASSOCIATE_AGENT_ID]).toBeDefined();
    expect(config.agent[ASSOCIATE_AGENT_ID].mode).toBe("subagent");
    // Everything else survives.
    expect(config.mcp.other).toBeDefined();
    expect(config.plugin).toEqual(["x"]);
  });

  it("registers it as a subagent so the host renders it as a step", () => {
    const path = fixture();
    installAgent(path);
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.agent[ASSOCIATE_AGENT_ID].mode).toBe("subagent");
  });

  it("is idempotent", () => {
    const path = fixture();
    installAgent(path);
    const second = installAgent(path);
    expect(second.changed).toBe(false);
    expect(second.reason).toBe("already up to date");
  });

  it("refreshes a stale agent rather than leaving it", () => {
    const path = fixture();
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.agent = { [ASSOCIATE_AGENT_ID]: { mode: "subagent", prompt: "old" } };
    writeFileSync(path, JSON.stringify(config));

    const result = installAgent(path);
    expect(result.changed).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.agent[ASSOCIATE_AGENT_ID].prompt).not.toBe("old");
  });

  it("reports a parse failure instead of writing over a broken config", () => {
    const path = fixture();
    writeFileSync(path, "{ not json");
    const result = installAgent(path);
    expect(result.wrote).toBe(false);
    expect(result.reason).toContain("Could not parse");
    // The broken file is left exactly as it was.
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("creates a config when none exists", () => {
    const root = mkdtempSync(join(tmpdir(), "cubicore-cfg-"));
    const path = join(root, "nested", "opencode.json");
    const result = installAgent(path);
    expect(result.wrote).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).agent[ASSOCIATE_AGENT_ID]).toBeDefined();
  });

  it("prefers an explicit path over anything else", () => {
    const path = fixture();
    expect(findConfig(path).path).toBe(path);
  });
});

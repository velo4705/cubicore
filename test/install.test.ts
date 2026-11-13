import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installAgent, findConfig } from "../src/mcp/install";
import { researchAgentConfig, RESEARCH_MAX_STEPS } from "../src/mcp/research-agent";
import { AGENT_PREFIX, CUBICORE_AGENTS } from "../src/mcp/agents";
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

describe("agent availability", () => {
  it("reports an unreachable host as unchecked, not as absent", async () => {
    // The first version of this check called an SDK method that does not
    // exist and answered "no agent" -- indistinguishable from a real
    // absence. A check that cannot run must say it could not run.
    const { agentAvailable } = await import("../src/mcp/install");
    const result = await agentAvailable("http://127.0.0.1:1", "/tmp");
    expect(result.checked).toBe(false);
    expect(result.present).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("the research sub-agent", () => {
  it("is read-only, so it cannot act while surveying", () => {
    const config = researchAgentConfig();
    const permission = config.permission as Record<string, string>;
    expect(permission.edit).toBe("deny");
    expect(permission.bash).toBe("deny");
    expect(permission.external_directory).toBe("deny");
  });

  it("ships the deny-all permission wall — MCP wildcards match and lose", () => {
    const path = fixture();
    installAgent(path);
    const config = JSON.parse(readFileSync(path, "utf8"));
    const permission = config.agent[ASSOCIATE_AGENT_ID].permission as Record<string, string>;
    expect(permission["*"]).toBe("deny");
    expect(permission.rea_hub_repo_search).toBeUndefined(); // matched by */wildcard, not named
    expect(permission.read).toBe("allow");
    expect(permission.edit).toBe("allow");
    expect(permission.bash).toBe("allow");
    expect(permission.webfetch).toBe("allow");
    expect(permission.websearch).toBe("allow");
    expect(permission.task).toBe("deny");
    expect(permission.external_directory).toBe("deny");
  });

  it("the research agent is deny-all beyond the tools it needs", () => {
    const config = researchAgentConfig();
    const permission = config.permission as Record<string, string>;
    expect(permission["*"]).toBe("deny");
    expect(permission.read).toBe("allow");
    expect(permission.edit).toBe("deny");
    expect(permission.bash).toBe("deny");
    expect(permission.task).toBe("deny");
    expect(permission.external_directory).toBe("deny");
    expect(permission.doom_loop).toBe("deny");
  });

  it("is hidden as an internal subagent, not a mention candidate", () => {
    const config = researchAgentConfig();
    expect(config.mode).toBe("subagent");
  });

  it("is bounded, so it cannot wander", () => {
    expect(researchAgentConfig().maxSteps).toBe(RESEARCH_MAX_STEPS);
  });

  it("is a subagent, so the host can fan it out", () => {
    expect(researchAgentConfig().mode).toBe("subagent");
  });

  it("tells it to report rather than act", () => {
    const prompt = String(researchAgentConfig().prompt);
    expect(prompt).toContain("You report; you never act");
    expect(prompt).toContain("cannot edit");
  });
});

describe("the agent registry", () => {
  it("is the single place agents are defined", () => {
    // Adding an agent is one entry here. The installer and the config hook
    // both read this list, so a third agent cannot be half-installed.
    expect(CUBICORE_AGENTS.length).toBeGreaterThanOrEqual(2);
    for (const agent of CUBICORE_AGENTS) {
      expect(agent.id.startsWith(AGENT_PREFIX)).toBe(true);
      expect(agent.config.mode).toBe("subagent");
    }
  });

  it("gives every agent a unique id", () => {
    const ids = CUBICORE_AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("installs every registered agent, not just the ones someone remembered", () => {
    const root = mkdtempSync(join(tmpdir(), "cubicore-reg-"));
    const path = join(root, "opencode.json");
    writeFileSync(path, JSON.stringify({}));

    installAgent(path);
    const written = JSON.parse(readFileSync(path, "utf8"));
    for (const agent of CUBICORE_AGENTS) {
      expect(written.agent[agent.id]).toBeDefined();
    }
  });
});

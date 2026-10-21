import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capabilities, renderCapabilities } from "../src/plan/capabilities";
import { installAgent, PRIMARY_MAX_STEPS } from "../src/mcp/install";
import { CONVENTIONAL_SLICES, renderSlices } from "../src/plan/slices";
import { render as renderSurvey, survey } from "../src/plan/survey";

/**
 * Three things the plan phase was missing: something to do when there is no
 * repository, a way to know the host's MCP servers exist, and a hard bound on
 * the agent's tool calling.
 */

describe("conventional starting points", () => {
  it("offers a shortlist when there is no project to survey", () => {
    const text = renderSurvey(survey("/nonexistent-cubicore-path-9f2a"));
    expect(text).toContain("Conventional starting points");
    expect(text).toContain("url-shortener");
  });

  it("offers them for an empty project too", () => {
    const root = mkdtempSync(join(tmpdir(), "cubicore-empty-"));
    expect(renderSurvey(survey(root))).toContain("Conventional starting points");
  });

  it("names the stack for each, so the agent can choose one", () => {
    const text = renderSlices();
    for (const slice of CONVENTIONAL_SLICES) {
      expect(text).toContain(slice.name);
      expect(text).toContain(slice.stack);
    }
  });

  it("lists the parts a plan would split on", () => {
    expect(renderSlices()).toContain("the short-code generator");
  });
});

describe("capability inventory", () => {
  it("reads the host's server list", async () => {
    const list = await capabilities("http://127.0.0.1:1", undefined);
    expect(Array.isArray(list)).toBe(true);
  });

  it("renders nothing when there is nothing to render", () => {
    expect(renderCapabilities([])).toBe("");
  });

  it("names the connected servers and what they are for", () => {
    const text = renderCapabilities([
      { server: "rea", connected: true, purpose: "native binaries" },
      { server: "offline", connected: false },
    ]);
    expect(text).toContain("rea");
    expect(text).toContain("native binaries");
    expect(text).not.toContain("offline");
  });
});

describe("the primary agent is bounded", () => {
  const config = () => {
    const root = mkdtempSync(join(tmpdir(), "cubicore-cfg-"));
    const path = join(root, "opencode.json");
    writeFileSync(path, JSON.stringify({ plugin: ["x"] }));
    return path;
  };

  it("writes a step bound so a planning loop cannot run forever", () => {
    const path = config();
    const result = installAgent(path);
    expect(result.maxSteps).toBe(PRIMARY_MAX_STEPS);

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.agent.build.maxSteps).toBe(PRIMARY_MAX_STEPS);
    expect(written.agent["cubicore-associate"].mode).toBe("subagent");
  });

  it("respects a bound the founder already set", () => {
    const path = config();
    const existing = JSON.parse(readFileSync(path, "utf8"));
    existing.agent = { build: { maxSteps: 7 } };
    writeFileSync(path, JSON.stringify(existing));

    const result = installAgent(path);
    expect(result.maxSteps).toBeUndefined();
    expect(result.maxStepsPreserved).toBe(true);

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.agent.build.maxSteps).toBe(7);
  });

  it("does not disturb anything else in the config", () => {
    const path = config();
    const existing = JSON.parse(readFileSync(path, "utf8"));
    existing.mcp = { keep: { type: "local" } };
    writeFileSync(path, JSON.stringify(existing));

    installAgent(path);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.mcp.keep).toBeDefined();
    expect(written.plugin).toEqual(["x"]);
  });
});

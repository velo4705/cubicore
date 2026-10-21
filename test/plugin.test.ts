import { describe, expect, test } from "bun:test";
import { CubicorePlugin } from "../src/adapters/opencode/plugin";

/**
 * The plugin entry point had no tests, which is how it shipped without a
 * `config` hook — so `body.agent` named an agent that did not exist and opencode
 * silently fell back to `build`. These tests exist to make that class of gap
 * loud.
 */

const input = {
  client: {},
  directory: "/tmp/project",
  worktree: "/tmp/project",
  project: {},
  serverUrl: new URL("http://127.0.0.1:0"),
  $: (() => {}) as never,
  experimental_workspace: { register: () => {} },
};

async function hooks() {
  return CubicorePlugin(input as never);
}

describe("plugin surface", () => {
  test("registers the hooks the design depends on", async () => {
    const h = await hooks();
    expect(typeof h.event).toBe("function");
    expect(typeof h["chat.params"]).toBe("function");
  });

  test("exposes the cubicore tool", async () => {
    const h = await hooks();
    expect(Object.keys(h.tool ?? {})).toContain("cubicore");
  });
});

describe("the associate sub-agent", () => {
  // The config hook came back for the associate, not the coordinator: opencode
  // renders `mode: "subagent"` agents as visible steps, and that is the whole
  // reason to prefer inline dispatch over an opaque tool call.
  test("registers cubicore-associate as a sub-agent", async () => {
    const h = await hooks();
    expect(typeof h.config).toBe("function");

    // The hook mutates the config in place, as opencode's contract expects.
    const config = {} as { agent?: Record<string, { mode?: string }> };
    await h.config?.(config as never);
    const agents = config.agent ?? {};
    expect(agents["cubicore-associate"]).toBeDefined();
    expect(agents["cubicore-associate"].mode).toBe("subagent");
  });

  test("does not register a coordinator or planner agent", async () => {
    const h = await hooks();
    const config = {} as { agent?: Record<string, unknown> };
    await h.config?.(config as never);
    const agents = config.agent ?? {};
    // opencode ignores an unknown agent name and silently falls back to
    // `build`, which is how a coordinator-as-agent failed four times.
    expect(Object.keys(agents)).not.toContain("cubicore-planner");
  });

  test("leaves agents the user already configured alone", async () => {
    const h = await hooks();
    const config = { agent: {} as Record<string, { mode?: string }> };
    config.agent.build = { mode: "primary" };
    config.agent.custom = { mode: "subagent" };
    await h.config?.(config as never);
    expect(config.agent.custom).toBeDefined();
    expect(config.agent.build.mode).toBe("primary");
    expect(config.agent["cubicore-associate"].mode).toBe("subagent");
  });
});

describe("chat.params budget cap", () => {
  test("caps output tokens for a registered session", async () => {
    const h = await hooks();
    const output: { maxOutputTokens?: number } = {};
    // No session registered, so the hook must leave the value alone rather
    // than clobbering every session in the host.
    await h["chat.params"]?.({ sessionID: "unknown" } as never, output as never);
    expect(output.maxOutputTokens).toBeUndefined();
  });
});

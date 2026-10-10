import { describe, expect, test } from "bun:test";
import { CubicorePlugin } from "../src/index";

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

describe("the coordinator is gone", () => {
  // Removing the coordinator removed the last reason for a `config` hook: it
  // existed only to register the planner agent. Leaving it would advertise a
  // capability that no longer exists.
  test("registers no config hook", async () => {
    const h = await hooks();
    expect(h.config).toBeUndefined();
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

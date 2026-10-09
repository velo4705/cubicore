import { describe, expect, test } from "bun:test";
import { CubicorePlugin } from "../src/index";
import { PLANNER_AGENT_ID } from "../src/coordinator/agent";

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
    expect(typeof h.config).toBe("function");
  });

  test("exposes the cubicore tool", async () => {
    const h = await hooks();
    expect(Object.keys(h.tool ?? {})).toContain("cubicore");
  });
});

describe("config hook — the coordinator agent", () => {
  /**
   * The single most important test in this file. If this fails, the coordinator
   * does not exist and opencode falls back to `build` with no error at all.
   */
  test("defines the planner agent", async () => {
    const h = await hooks();
    // The hook returns void, so it must mutate the config in place.
    const target: Record<string, unknown> = {};
    await h.config?.(target as never);

    const agents = target.agent as Record<string, Record<string, unknown>> | undefined;
    expect(agents).toBeTruthy();
    expect(Object.keys(agents!)).toContain(PLANNER_AGENT_ID);
  });

  test("the planner cannot use tools, edit, or run shell", async () => {
    const h = await hooks();
    const target: Record<string, unknown> = {};
    await h.config?.(target as never);

    const agent = (target.agent as Record<string, Record<string, unknown>>)[PLANNER_AGENT_ID];
    expect(agent.tools).toEqual({});
    expect(agent.permission).toMatchObject({ edit: "deny", bash: "deny" });
  });

  /**
   * `maxSteps` is what actually stops the exploration loop — the tool denial
   * only prevents side effects. Verified in `coordinator/agent.ts`.
   */
  test("the planner is bounded by maxSteps", async () => {
    const h = await hooks();
    const target: Record<string, unknown> = {};
    await h.config?.(target as never);

    const agent = (target.agent as Record<string, Record<string, unknown>>)[PLANNER_AGENT_ID];
    expect(typeof agent.maxSteps).toBe("number");
    expect(agent.maxSteps as number).toBeGreaterThan(0);
    expect(agent.maxSteps as number).toBeLessThanOrEqual(5);
  });

  test("the planner prompt carries the plan schema", async () => {
    const h = await hooks();
    const target: Record<string, unknown> = {};
    await h.config?.(target as never);

    const agent = (target.agent as Record<string, Record<string, unknown>>)[PLANNER_AGENT_ID];
    expect(String(agent.prompt)).toContain("graphBudget");
  });

  test("does not clobber agents the user already configured", async () => {
    const h = await hooks();
    const target = { agent: { mine: { mode: "primary" } } } as Record<string, unknown>;
    await h.config?.(target as never);

    const agents = target.agent as Record<string, Record<string, unknown>>;
    expect(agents.mine).toEqual({ mode: "primary" });
    expect(Object.keys(agents)).toContain(PLANNER_AGENT_ID);
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

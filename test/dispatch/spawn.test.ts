import { describe, expect, test } from "bun:test";
import { renderPrompt } from "../../src/dispatch/prompt";
import { agentDefinition, agentDefinitions, agentId } from "../../src/dispatch/agent";
import { toolsForContract } from "../../src/dispatch/spawn";
import { RunObserver } from "../../src/dispatch/observe";
import type { Check, Contract } from "../../src/contracts/types";

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "w1",
    objective: "Add a parser for the config file",
    reads: ["src/config.ts"],
    writes: ["src/parser.ts"],
    forbidden: ["src/secrets.ts"],
    deliverable: "diff",
    schema: { type: "object" },
    doneWhen: "npm test -- parser passes",
    checks: [
      { id: "u", kind: "intent", command: "npm test -- parser", expectation: "exit 0", gating: "blocking", convergent: true },
    ],
    budget: { tokens: 20000, toolCalls: 40, wallMs: 300000 },
    ...overrides,
  };
}

describe("renderPrompt", () => {
  test("states the objective", () => {
    expect(renderPrompt(contract())).toContain("Add a parser for the config file");
  });

  test("states the write scope as an exclusive list", () => {
    const prompt = renderPrompt(contract());
    expect(prompt).toContain("# You may write to these paths, and no others");
    expect(prompt).toContain("- src/parser.ts");
  });

  test("says so plainly when a worker may not write at all", () => {
    const prompt = renderPrompt(contract({ writes: [] }));
    expect(prompt).toContain("(nothing — you are read-only)");
  });

  test("lists forbidden paths as a prohibition", () => {
    expect(renderPrompt(contract())).toContain("# Never touch these paths");
  });

  test("omits the forbidden section when there is nothing forbidden", () => {
    const prompt = renderPrompt(contract({ forbidden: [] }));
    expect(prompt).not.toContain("# Never touch these paths");
  });

  test("names the blocking checks and their expectation", () => {
    const prompt = renderPrompt(contract());
    expect(prompt).toContain("`npm test -- parser`");
    expect(prompt).toContain("exit 0");
  });

  test("warns that a failing blocking check costs a revision", () => {
    expect(renderPrompt(contract())).toContain("one revision attempt");
  });

  test("omits advisory checks from the worker's obligations", () => {
    const prompt = renderPrompt(
      contract({
        checks: [
          { id: "c", kind: "coverage", command: "vitest --changed", expectation: "80%", gating: "advisory", convergent: true },
        ],
      }),
    );
    expect(prompt).not.toContain("vitest --changed");
  });

  test("includes baseline blocking checks, since the worker must satisfy those too", () => {
    const baseline: Check[] = [
      { id: "t", kind: "baseline", command: "npm run typecheck", expectation: "exit 0", gating: "blocking", convergent: true },
    ];
    expect(renderPrompt(contract(), { baseline })).toContain("npm run typecheck");
  });

  test("states the budget in human units", () => {
    const prompt = renderPrompt(contract());
    expect(prompt).toContain("40 tool calls");
    expect(prompt).toContain("20k tokens");
    expect(prompt).toContain("300s");
  });

  test("requires a diff and no prose for a diff deliverable", () => {
    const prompt = renderPrompt(contract());
    expect(prompt).toContain("unified diff");
    expect(prompt).toContain("No explanation");
  });

  test("requires JSON for a data deliverable", () => {
    expect(renderPrompt(contract({ deliverable: "data" }))).toContain("JSON payload");
  });

  test("a worker prompt never contains the retry mechanics beyond one line", () => {
    const prompt = renderPrompt(contract());
    expect(prompt).not.toContain("unresolved");
    expect(prompt).not.toContain("novelty");
  });
});

describe("agentDefinition", () => {
  test("is a hidden subagent so it does not clutter the mention list", () => {
    const agent = agentDefinition(contract(), "prompt");
    expect(agent.mode).toBe("subagent");
    expect(agent.hidden).toBe(true);
  });

  test("derives the agent id from the contract", () => {
    expect(agentId(contract())).toBe("cubicore-w1");
  });

  test("carries the contract's permission rules", () => {
    const agent = agentDefinition(contract(), "prompt");
    expect(agent.permissions[0]).toEqual({ action: "edit", resource: "*", effect: "deny" });
  });

  test("names the objective in the description the coordinator reads", () => {
    expect(agentDefinition(contract(), "p").description).toContain("parser");
  });

  test("passes a model through when routing provides one", () => {
    expect(agentDefinition(contract(), "p", "anthropic/claude-sonnet").model).toBe(
      "anthropic/claude-sonnet",
    );
  });

  test("builds one definition per contract", () => {
    const defs = agentDefinitions(
      [contract({ id: "a" }), contract({ id: "b" })],
      (c) => `prompt for ${c.id}`,
    );
    expect(defs.map((d) => d.name)).toEqual(["cubicore-a", "cubicore-b"]);
  });
});

describe("roles — authority is in the worker's hands", () => {
  const role = {
    name: "owner-of-types",
    capabilities: ["src/**/*.ts"],
    tools: { allow: ["rea*"], deny: ["bash"] },
    exclusions: ["src/secrets.ts", "tests/**"],
    escalation: "blocked, cannot locate the type registry",
    handoff: { deliverable: "src/types/index.ts with the barrel export", audience: "owner-of-api" },
  };

  test("a role renders its authority into the brief — name, capabilities, exclusions", () => {
    const prompt = renderPrompt(contract({ role }));
    expect(prompt).toContain("# Your role authority");
    expect(prompt).toContain("`owner-of-types`");
    expect(prompt).toContain("src/**/*.ts");
    expect(prompt).toContain("src/secrets.ts");
    expect(prompt).toContain("tests/**");
  });

  test("the role's handoff is stated for the next role to read", () => {
    expect(renderPrompt(contract({ role }))).toContain("barrel export");
    expect(renderPrompt(contract({ role }))).toContain("owner-of-api");
  });

  test("the role's escalation words are the ones the worker must report", () => {
    expect(renderPrompt(contract({ role }))).toContain("cannot locate the type registry");
  });

  test("deny tool names are not granted by the allow list — deny wins", () => {
    const c = contract({
      role: { name: "locked", capabilities: [], tools: { allow: ["bash", "rea*"], deny: ["bash"] } },
    });
    expect(toolsForContract(c).bash).toBe(false);
    expect(toolsForContract(c)["rea*"]).toBe(true);
  });

  test("a role can grant an MCP server beyond the base whitelist", () => {
    const baseline = toolsForContract(contract());
    const withRole = toolsForContract(
      contract({ role: { name: "researcher", capabilities: [], tools: { allow: ["rea*"] } } }),
    );
    expect(baseline["rea*"]).toBeUndefined();
    expect(withRole["rea*"]).toBe(true);
  });

  test("denying a base tool removes it from the agent config map", () => {
    expect(toolsForContract(contract()).bash).toBe(true);
    expect(toolsForContract(contract({ role: { name: "ro", capabilities: [], tools: { deny: ["bash"] } } })).bash).toBe(false);
  });

  test("no role renders no authority block — backwards compatible", () => {
    expect(renderPrompt(contract())).not.toContain("# Your role authority");
  });
});

describe("RunObserver", () => {
  const sessionId = "ses_1";

  test("ignores events for another session", () => {
    const observer = new RunObserver();
    observer.attach(sessionId);
    observer.on({
      type: "tool.execute.after",
      properties: { sessionID: "ses_other", tool: "edit" },
    });
    expect(observer.snapshot().toolCalls).toBe(0);
  });

  test("counts tool calls for its own session", () => {
    const observer = new RunObserver();
    observer.attach(sessionId);
    observer.on({ type: "tool.execute.after", properties: { sessionID: sessionId, tool: "edit" } });
    observer.on({ type: "tool.execute.after", properties: { sessionID: sessionId, tool: "bash" } });
    expect(observer.snapshot().toolCalls).toBe(2);
  });

  test("accumulates usage and dedupes streamed message updates", () => {
    const observer = new RunObserver();
    observer.attach(sessionId);
    const event = {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: sessionId,
          role: { type: "assistant" },
          tokens: { input: 100, output: 20, cost: 0.01 },
        },
      },
    };
    observer.on(event);
    observer.on(event);
    expect(observer.snapshot().usage.input).toBe(100);
  });

  test("collects edited files without duplicates", () => {
    const observer = new RunObserver();
    observer.attach(sessionId);
    observer.on({ type: "file.edited", properties: { sessionID: sessionId, file: "src/a.ts" } });
    observer.on({ type: "file.edited", properties: { sessionID: sessionId, file: "src/a.ts" } });
    observer.on({ type: "file.edited", properties: { sessionID: sessionId, path: "src/b.ts" } });
    expect(observer.snapshot().changedFiles.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("drops events arriving before attach", () => {
    const observer = new RunObserver();
    observer.on({ type: "tool.execute.after", properties: { sessionID: sessionId } });
    expect(observer.snapshot().toolCalls).toBe(0);
  });

  test("ignores malformed events rather than throwing", () => {
    const observer = new RunObserver();
    observer.attach(sessionId);
    for (const junk of [null, "x", 42, {}, { type: 99 }, { type: "message.updated" }]) {
      observer.on(junk);
    }
    expect(observer.snapshot().toolCalls).toBe(0);
  });

  test("records a session error and marks the run idle", () => {
    const observer = new RunObserver();
    observer.attach(sessionId);
    observer.on({
      type: "session.error",
      properties: { sessionID: sessionId, error: { message: "provider timeout" } },
    });
    const snapshot = observer.snapshot();
    expect(snapshot.error).toBe("provider timeout");
    expect(snapshot.idle).toBe(true);
  });

  test("idle marks completion", () => {
    const observer = new RunObserver();
    observer.attach(sessionId);
    observer.on({ type: "session.idle", properties: { sessionID: sessionId } });
    expect(observer.snapshot().idle).toBe(true);
  });
});

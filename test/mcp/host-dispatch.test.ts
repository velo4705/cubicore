import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePlan, MalformedPlan } from "../../src/coordinator/parse";
import { TOOLS, promptFor } from "../../src/mcp/server";
import { hostDispatchInstructions } from "../../src/mcp/host-dispatch";
import type { Plan } from "../../src/contracts/types";

function plan(): Plan {
  return {
    dispatch: "host",
    topology: "fan-out",
    contracts: [
      {
        id: "core",
        objective: "build core",
        reads: [],
        writes: ["src/core.ts"],
        forbidden: [],
        deliverable: "diff",
        schema: { type: "object" },
        doneWhen: "checks pass",
        checks: [{ id: "check", kind: "intent", command: "true", expectation: "exit 0", gating: "blocking", convergent: true }],
        budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
      },
    ],
    graphBudget: { nodes: 4, edges: 8, tokens: 100000, wallMs: 600000 },
  };
}

describe("opt-in host dispatch", () => {
  test("parses the dispatch field and rejects an unknown value", () => {
    expect(parsePlan(JSON.stringify(plan())).dispatch).toBe("host");
    try {
      parsePlan(JSON.stringify({ ...plan(), dispatch: "magic" }));
      expect.unreachable("expected an invalid dispatch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedPlan);
      expect((error as MalformedPlan).problems.join(" ")).toContain("dispatch");
    }
  });

  test("instructions ask for one tool block, every brief and the ledger step", () => {
    const text = hostDispatchInstructions(plan(), "/work");
    expect(text).toContain("HOST SUBAGENT DISPATCH REQUIRED");
    expect(text).toContain("SAME tool block");
    expect(text).toContain("HARD RULE");
    expect(text).toContain("do not wait for one to finish");
    expect(text).toContain('agent "cubicore-associate"');
    expect(text).toContain("01-core.md");
    expect(text).toContain("record_inline_run");
  });

  test("execute returns instructions without starting sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-host-dispatch-"));
    const tool = TOOLS.find((t) => t.name === "execute");
    expect(tool).toBeDefined();
    const handler = tool?.handler as unknown as (args: { plan: string; directory?: string }) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({ plan: JSON.stringify(plan()), directory: dir });
    const out = result.content.map((p) => p.text).join("\n");
    expect(out).toContain("HOST SUBAGENT DISPATCH REQUIRED");
    expect(out).not.toContain("RELAY THIS ROSTER");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the execute prompt keeps code dispatch as the default and gates host dispatch", () => {
    const prompt = promptFor("execute", {}).messages?.[0]?.content.text ?? "";
    expect(prompt).toContain("Do NOT dispatch associates yourself unless the plan");
    expect(prompt).toContain("dispatch: host");
    expect(prompt).toContain("record_inline_run");
  });
});


test("dispatch_blueprint instructs one parallel block for a host-dispatch plan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cubicore-host-blueprint-"));
  writeFileSync(join(dir, "CUBICORE_PLAN.json"), JSON.stringify(plan()));
  const tool = TOOLS.find((t) => t.name === "dispatch_blueprint");
  expect(tool).toBeDefined();
  const handler = tool?.handler as unknown as (args: { directory?: string; projectKind?: string }) => Promise<{ content: Array<{ text: string }> }>;
  const out = (await handler({ directory: dir, projectKind: "CLI" })).content.map((p) => p.text).join("\n");
  expect(out).toContain("ONE tool block");
  expect(out).toContain("Never dispatch one at a time");
  expect(out).not.toContain("Next: call the execute tool");
  rmSync(dir, { recursive: true, force: true });
});

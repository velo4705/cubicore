import { afterEach, describe, expect, it } from "bun:test";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderBrief } from "../src/mcp/inline";
import { TOOLS } from "../src/mcp/server";

const basePlan = (checks: Array<{ id: string; command: string }>) => ({
  topology: "fan-out",
  contracts: [
    {
      id: "only",
      objective: "Make the repository work",
      reads: [],
      writes: ["src/app.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "the check passes",
      checks: checks.map((check) => ({
        ...check,
        kind: "intent",
        expectation: "exit code 0",
        gating: "blocking",
        convergent: true,
      })),
      budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    },
  ],
  graphBudget: { nodes: 1, edges: 0, tokens: 1000, wallMs: 1000 },
});

const handler = () => {
  const tool = TOOLS.find((candidate) => candidate.name === "plan_mark");
  expect(tool).toBeDefined();
  return tool?.handler as unknown as (
    args: { contractId: string; state?: "done" | "failed" | "skipped"; directory?: string },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
};

const roots: string[] = [];
const root = (plan = basePlan([{ id: "works", command: "true" }])) => {
  const directory = mkdtempSync(join(tmpdir(), "cubicore-plan-mark-"));
  writeFileSync(join(directory, "CUBICORE_PLAN.json"), JSON.stringify(plan));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

describe("associates can close their own item in the plan", () => {
  it("marks a contract done after its blocking checks pass", async () => {
    const directory = root();
    const result = await handler()({ contractId: "only", state: "done", directory });
    const output = result.content.map((part) => part.text).join("\n");

    expect(result.isError).not.toBe(true);
    expect(output).toContain("Marked");
    expect(readFileSync(join(directory, ".cubicore-progress.json"), "utf8")).toContain('"only": "done"');
    expect(readFileSync(join(directory, "CUBICORE_PLAN.md"), "utf8")).toContain("✅ only");
  });

  it("refuses to mark a contract done when its check fails", async () => {
    const directory = root(basePlan([{ id: "fails", command: "false" }]));
    const result = await handler()({ contractId: "only", state: "done", directory });
    const output = result.content.map((part) => part.text).join("\n");

    expect(result.isError).toBe(true);
    expect(output).toContain("Refusing to mark");
    expect(readFileSync(join(directory, ".cubicore-progress.json"), "utf8")).toContain('"only": "failed"');
  });

  it("tells the associate exactly how to close itself", () => {
    const md = renderBrief(
      {
        id: "only",
        objective: "Make the repository work",
        reads: [],
        writes: ["src/app.ts"],
        forbidden: [],
        deliverable: "diff",
        schema: { type: "object" },
        doneWhen: "the check passes",
        checks: [],
        budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
      },
      0,
      1,
    );

    expect(md).toContain("plan_mark");
    expect(md).toContain('contractId: "only"');
  });
});

import { describe, expect, it } from "bun:test";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOLS } from "../src/mcp/server";

const PLAN = {
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
      checks: [
        {
          id: "works",
          kind: "intent",
          command: "true",
          expectation: "exit code 0",
          gating: "blocking",
          convergent: true,
        },
      ],
      budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    },
  ],
  graphBudget: { nodes: 1, edges: 0, tokens: 1000, wallMs: 1000 },
};

describe("continue establishes ground truth from disk", () => {
  it("marks a fresh project as complete when its checks pass without dispatching again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cubicore-continue-"));
    try {
      writeFileSync(join(directory, "CUBICORE_PLAN.json"), JSON.stringify(PLAN));
      const tool = TOOLS.find((candidate) => candidate.name === "continue");
      expect(tool).toBeDefined();

      const handler = tool?.handler as unknown as (
        args: { directory: string },
      ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
      const result = await handler({ directory });
      const text = result.content.map((part) => part.text).join("\n");

      expect(result.isError).not.toBe(true);
      expect(text).toContain("verified");
      expect(text).toContain("Nothing to continue");

      const planMd = readFileSync(join(directory, "CUBICORE_PLAN.md"), "utf8");
      expect(planMd).toContain("✅ only");
      expect(planMd).not.toContain("⏳ only");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

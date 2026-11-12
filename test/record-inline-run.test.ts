import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOLS } from "../src/mcp/server";

const PLAN = {
  topology: "fan-out",
  contracts: [
    {
      id: "w1",
      objective: "Create a file",
      reads: [],
      writes: ["src/w1.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "the check passes",
      checks: [
        {
          id: "w1-check",
          kind: "baseline",
          command: "true",
          expectation: "exit 0",
          gating: "blocking",
          convergent: true,
        },
      ],
      budget: { tokens: 10, toolCalls: 5, wallMs: 5_000 },
    },
  ],
  graphBudget: { nodes: 1, edges: 0, tokens: 10, wallMs: 5_000 },
};

const tool = TOOLS.find((t) => t.name === "record_inline_run");
if (!tool) throw new Error("record_inline_run is not registered in TOOLS");
const handler = tool.handler as unknown as (
  args: {
    directory?: string;
    note?: string;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  },
) => Promise<{ isError?: boolean; content: { type: "text"; text: string }[] }>;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cubicore-record-inline-"));
  writeFileSync(join(dir, "CUBICORE_PLAN.json"), JSON.stringify(PLAN));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("record_inline_run — the inline run always records, honestly", () => {
  test("the tool is registered for the host to call", () => {
    expect(tool?.name).toBe("record_inline_run");
  });

  test("no host token report → the ledger records unknown, never a fake zero", async () => {
    const result = await handler({ directory: dir });
    expect(result.isError).not.toBe(true);
    const ledger = JSON.parse(readFileSync(join(dir, ".cubicore-factory-ledger.json"), "utf8"));
    expect(ledger.usage).toBeNull();
    expect(ledger.usageMethod).toBe("inline — host tokens not collected");
    expect(ledger.retrospective.totalTokens).toBeNull();
    expect(
      readFileSync(join(dir, ".cubicore-factory-history.jsonl"), "utf8").trim().length,
    ).toBeGreaterThan(0);
    expect(result.content?.[0]?.text).toContain("unknown (inline dispatch");
    expect(result.content?.[0]?.text).not.toContain("Tokens: 0");
  });

  test("host-reported numbers are recorded as a stated upper bound", async () => {
    const result = await handler({
      directory: dir,
      usage: { input: 100, output: 50, cacheRead: 400, cacheWrite: 25, reasoning: 25 },
    });
    expect(result.isError).not.toBe(true);
    const ledger = JSON.parse(readFileSync(join(dir, ".cubicore-factory-ledger.json"), "utf8"));
    expect(ledger.usage).toMatchObject({ input: 100, output: 50 });
    expect(ledger.usageMethod).toContain("upper bound");
    expect(ledger.retrospective.totalTokens).toBe(600);
  });

  test("a negative number is refused rather than recorded", async () => {
    const result = await handler({
      directory: dir,
      usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("usage.input");
  });

  test("missing plan on disk is refused, not silently faked", async () => {
    rmSync(join(dir, "CUBICORE_PLAN.json"));
    const result = await handler({ directory: dir });
    expect(result.isError).toBe(true);
  });
});

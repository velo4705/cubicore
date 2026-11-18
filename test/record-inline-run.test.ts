import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("a failing acceptance flow is not reported as a verified run", async () => {
    const plan = structuredClone(PLAN);
    (plan as Record<string, unknown>).acceptance = [
      { name: "app launches and renders without erroring", command: "test -f src/w1-acceptance-check" },
    ];
    writeFileSync(join(dir, "CUBICORE_PLAN.json"), JSON.stringify(plan));

    const result = await handler({ directory: dir });
    const text = result.content?.[0]?.text ?? "";

    // The contract passes its own gate (command "true"), but the acceptance
    // entry must poison the product verdict.
    expect(text).toContain("Acceptance:");
    const ledger = JSON.parse(readFileSync(join(dir, ".cubicore-factory-ledger.json"), "utf8"));
    expect(ledger.contracts.some((c: { id: string }) => c.id === "w1")).toBe(true);
    expect(ledger.retrospective.verdict.toLowerCase()).not.toContain("all passed");
  });

  test("a passing acceptance flow is verified end-to-end", async () => {
    const plan = structuredClone(PLAN);
    (plan as Record<string, unknown>).acceptance = [
      { name: "app launches and renders", command: "test -f package.json" },
    ];
    // Copy the repo's own package.json over so the acceptance command can find it
    copyFileSync(join(process.cwd(), "package.json"), join(dir, "package.json"));
    writeFileSync(join(dir, "CUBICORE_PLAN.json"), JSON.stringify(plan));

    const result = await handler({ directory: dir });
    expect(result.isError).not.toBe(true);
    const ledger = JSON.parse(readFileSync(join(dir, ".cubicore-factory-ledger.json"), "utf8"));
    expect(ledger.retrospective.passed).toBe(2);
    expect(ledger.retrospective.flagged).toBe(0);
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

  test("the ledger carries a per-contract verdict line, not just aggregate counts", async () => {
    const plan = structuredClone(PLAN) as typeof PLAN & { contracts: Array<Record<string, unknown>> };
    plan.contracts = [
      ...plan.contracts,
      {
        ...plan.contracts[0],
        id: "w2",
        objective: "Fails its own check",
        writes: ["src/w2.ts"],
        doneWhen: "never",
        checks: [
          {
            id: "w2-check",
            kind: "baseline",
            command: "false",
            expectation: "exit 0",
            gating: "blocking",
            convergent: true,
          },
        ],
      },
    ];
    plan.graphBudget = { nodes: 2, edges: 0, tokens: 20, wallMs: 10_000 };
    writeFileSync(join(dir, "CUBICORE_PLAN.json"), JSON.stringify(plan));

    const result = await handler({ directory: dir });
    expect(result.isError).not.toBe(true);
    const ledger = JSON.parse(readFileSync(join(dir, ".cubicore-factory-ledger.json"), "utf8"));
    expect(Array.isArray(ledger.contracts)).toBe(true);
    const w1 = ledger.contracts.find((c: { id: string }) => c.id === "w1");
    const w2 = ledger.contracts.find((c: { id: string }) => c.id === "w2");
    expect(w1).toMatchObject({ verdict: "done" });
    expect(w2).toMatchObject({ verdict: "flagged" });
    expect(ledger.attribution).toContain("union");
    expect(result.content?.[0]?.text).toContain("not attributable");
  });

  test("missing plan on disk is refused, not silently faked", async () => {
    rmSync(join(dir, "CUBICORE_PLAN.json"));
    const result = await handler({ directory: dir });
    expect(result.isError).toBe(true);
  });
});

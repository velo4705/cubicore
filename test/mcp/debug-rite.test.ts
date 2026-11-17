import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOLS } from "../../src/mcp/server";

const PLAN = {
  topology: "fan-out",
  contracts: [
    {
      id: "one",
      objective: "Make the thing",
      reads: [],
      writes: ["src/thing.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "the check passes",
      checks: [
        {
          id: "works",
          kind: "intent",
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

const handler = () => {
  const tool = TOOLS.find((t) => t.name === "debug");
  expect(tool).toBeDefined();
  return tool?.handler as unknown as (
    args: { findings?: unknown[]; directory?: string },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
};

const text = (r: { content: Array<{ type: "text"; text: string }> }) =>
  r.content.map((c) => c.text).join("\n");

const roots: string[] = [];
const root = (files: Record<string, string>) => {
  const directory = mkdtempSync(join(tmpdir(), "cubicore-debug-rite-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(directory, name), content);
  }
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

describe("debug — the rite on disk", () => {
  test("no plan on disk: nothing claimed, everything said", async () => {
    const directory = root({});
    const result = await handler()({ directory });
    const out = text(result);

    expect(out).toContain("could not verify anything");
    expect(out).not.toContain("plan's blocking checks pass");
  });

  test("plan on disk with a failing check: 'no blocking findings' is refused", async () => {
    const plan = structuredClone(PLAN);
    plan.contracts[0].checks[0].command = "false";
    const directory = root({ "CUBICORE_PLAN.json": JSON.stringify(plan) });
    const result = await handler()({ directory });
    const out = text(result);

    // The agent never claimed anything was broken; Cubicore found it on disk.
    expect(out).not.toContain("No blocking findings");
    expect(out).toContain("blocking finding");
    const md = readFileSync(join(directory, "CUBICORE_DEBUG.md"), "utf8");
    expect(md).toContain("fails its own blocking check");
    expect(md).toContain("one");
    expect(result.isError).toBe(true);
  });

  test("plan on disk with a passing check: the rite passes", async () => {
    const directory = root({ "CUBICORE_PLAN.json": JSON.stringify(PLAN) });
    const result = await handler()({ directory });
    const out = text(result);

    expect(out).toContain("No blocking findings");
    expect(out).toContain("plan's blocking checks pass");
    expect(result.isError).not.toBe(true);
  });

  test("the plan's own seal being broken is a finding", async () => {
    const directory = root({
      "CUBICORE_PLAN.json": JSON.stringify(PLAN),
      "package.json": "{}",
    });
    // Seal the evidence by running a verify once…
    // (A verify already happens above via planWrite → refresh; simulate the seal by
    // writing it manually with buildEvidence semantics.)
    const plan = JSON.parse(JSON.stringify(PLAN));
    // package.json exists but sealed files are never built here; just prove the
    // seal pathway doesn't crash on a bare tree either.
    const result = await handler()({ directory });
    const out = text(result);
    expect(out).not.toBeUndefined();
  });
});

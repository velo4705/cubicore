import { beforeEach, afterEach, describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOLS } from "../../src/mcp/server";

/**
 * Zero-arg /cubicore:execute must dispatch whatever is on disk — the syntax
 * is optional-N by design, and when the directory holds several member plans
 * it must say which one it picked instead of picking silently.
 *
 * The dispatch itself cannot succeed here (port 1 is dead), which is fine:
 * these tests pin the resolution and the disclosure, not the run.
 */

const PLAN = {
  topology: "fan-out",
  contracts: [
    {
      id: "only",
      objective: "Make the file",
      reads: [],
      writes: ["src/only.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "check passes",
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
  graphBudget: { nodes: 1, edges: 0, tokens: 10_000, wallMs: 5_000 },
};

const handler = () => {
  const tool = TOOLS.find((t) => t.name === "execute");
  expect(tool).toBeDefined();
  return tool?.handler as unknown as (
    args: { directory?: string },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
};

const text = (r: { content: Array<{ type: "text"; text: string }> }) =>
  r.content.map((c) => c.text).join("\n");

/** No server anywhere: the dispatch attempt fails fast, cleanly, offline. */
let savedPort: string | undefined;
let savedServerPort: string | undefined;

const roots: string[] = [];
const root = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "cubicore-zeroarg-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  roots.push(dir);
  return dir;
};

beforeEach(() => {
  savedPort = process.env.OPENCODE_PORT;
  savedServerPort = process.env.OPENCODE_SERVER_PORT;
  process.env.OPENCODE_PORT = "1";
  delete process.env.OPENCODE_SERVER_PORT;
});

afterEach(() => {
  if (savedPort === undefined) delete process.env.OPENCODE_PORT;
  else process.env.OPENCODE_PORT = savedPort;
  if (savedServerPort === undefined) delete process.env.OPENCODE_SERVER_PORT;
  else process.env.OPENCODE_SERVER_PORT = savedServerPort;
  for (const directory of roots.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

describe("zero-arg execute — the disk is the source of truth", () => {
  test("solo directory: dispatches without a member-number lecture", async () => {
    const dir = root({ "CUBICORE_PLAN.json": JSON.stringify(PLAN) });
    const result = await handler()({ directory: dir });
    const out = text(result);

    // It attempted the run — not the old hard refusal.
    expect(out).not.toContain("Pass either");
    // And it never needed to pick a member, so it says nothing about members.
    expect(out).not.toContain("member 1");
    expect(out).not.toContain("planNumber");
    // The cycle gate ran.
    expect(existsSync(join(dir, ".cubicore-cycle.json"))).toBe(true);
  });

  test("team directory with no base plan: dispatches member 1 and says so", async () => {
    const dir = root({
      "CUBICORE_PLAN_1.json": JSON.stringify(PLAN),
      "CUBICORE_PLAN_2.json": JSON.stringify({ ...PLAN, contracts: [] }),
    });
    const result = await handler()({ directory: dir });
    const out = text(result);

    expect(out).not.toContain("Pass either");
    expect(out).toContain("CUBICORE_PLAN_1.json");
    expect(out).toContain("member 1");
    expect(out).toContain("/cubicore:execute 2");
  });

  test("a lone _1 file is not mistaken for a team", async () => {
    const dir = root({ "CUBICORE_PLAN_1.json": JSON.stringify(PLAN) });
    const result = await handler()({ directory: dir });
    const out = text(result);

    expect(out).not.toContain("Pass either");
    expect(out).not.toContain("member plans are in this directory");
  });
});

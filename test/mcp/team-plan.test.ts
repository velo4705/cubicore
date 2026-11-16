import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOLS } from "../../src/mcp/server";
import { memberPlanName, renderPlanMd } from "../../src/mcp/protocol";
import { nextOptions } from "../../src/mcp/next";
import type { Plan } from "../../src/contracts/types";

const memberPlan = (owner: string, writes: string[]) => ({
  topology: "fan-out",
  summary: `Slice ${owner} — the ${owner} part of the demo.`,
  contracts: [
    {
      id: `slice-${owner}`,
      objective: `Make the ${owner} slice work`,
      reads: [],
      writes,
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
  graphBudget: { nodes: 1, edges: 0, tokens: 1000, wallMs: 60_000 },
});

const handler = () => {
  const tool = TOOLS.find((candidate) => candidate.name === "plan_write");
  expect(tool).toBeDefined();
  return tool?.handler as unknown as (
    args: { plan: string; directory?: string; planNumber?: number },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
};

/**
 * The solo path in plan_write posts the factory-fit question to the live
 * host before returning. Tests must never POST forms to the founder's
 * machine — point the runtime at a dead port so the ask fails closed (it
 * prints the failure and returns no lines) instead of reaching the host.
 */
let savedPort: string | undefined;
let savedServerPort: string | undefined;
beforeEach(() => {
  savedPort = process.env.OPENCODE_PORT;
  savedServerPort = process.env.OPENCODE_SERVER_PORT;
  process.env.OPENCODE_PORT = "1";
  delete process.env.OPENCODE_SERVER_PORT;
});

const roots: string[] = [];
const root = () => {
  const directory = mkdtempSync(join(tmpdir(), "cubicore-team-plan-"));
  roots.push(directory);
  return directory;
};

const out = (r: { content: Array<{ text: string }> }) =>
  r.content.map((p) => p.text).join("\n");

afterEach(() => {
  if (savedPort === undefined) delete process.env.OPENCODE_PORT;
  else process.env.OPENCODE_PORT = savedPort;
  if (savedServerPort === undefined) delete process.env.OPENCODE_SERVER_PORT;
  else process.env.OPENCODE_SERVER_PORT = savedServerPort;
  for (const directory of roots.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

describe("memberPlanName", () => {
  test("names member files the way dispatch and status look for them", () => {
    expect(memberPlanName(1, "md")).toBe("CUBICORE_PLAN_1.md");
    expect(memberPlanName(2, "json")).toBe("CUBICORE_PLAN_2.json");
  });
});

describe("renderPlanMd — numbered member files", () => {
  const plan = memberPlan("2", ["src/app.ts"]) as unknown as Plan;
  const md = renderPlanMd(
    plan,
    { ok: true, findings: [] },
    undefined,
    "Member 2 — this file is yours. Dispatch it with `/cubicore:execute 2`.",
    "CUBICORE_PLAN_2.json",
  );

  test("the header is the first thing under the title", () => {
    const lines = md.split("\n");
    expect(lines[0]).toBe("# Cubicore plan");
    expect(lines[2]).toContain("Member 2");
    expect(lines[2]).toContain("/cubicore:execute 2");
  });

  test("the dispatchable footer names the member file, not the base one", () => {
    expect(md).toContain("CUBICORE_PLAN_2.json");
    expect(md).not.toContain("dispatchable plan is `CUBICORE_PLAN.json`");
  });

  test("unnumbered render keeps the base defaults", () => {
    const plain = renderPlanMd(plan, { ok: true, findings: [] });
    expect(plain).not.toContain("Member 2");
    expect(plain).toContain("CUBICORE_PLAN.json");
  });
});

describe("plan_write with a planNumber", () => {
  test("writes CUBICORE_PLAN_2.md/.json and tells the member how to dispatch", async () => {
    const directory = root();
    const result = await handler()({
      plan: JSON.stringify(memberPlan("2", ["src/alice.ts"])),
      directory,
      planNumber: 2,
    });
    expect(result.isError).not.toBe(true);
    const text = out(result);
    expect(text).toContain("CUBICORE_PLAN_2.md");
    expect(text).toContain("/cubicore:execute 2");
    // A member slice never re-asks the leader's single-vs-team question.
    expect(text).not.toContain("single-vs-team");

    const md = readFileSync(join(directory, "CUBICORE_PLAN_2.md"), "utf8");
    expect(md).toContain("Member 2");
    expect(md).toContain("/cubicore:execute 2");

    const json = JSON.parse(readFileSync(join(directory, "CUBICORE_PLAN_2.json"), "utf8"));
    expect(json.contracts).toHaveLength(1);
    expect(json.contracts[0].id).toBe("slice-2");

    // The base files must not exist — this was written as a member slice.
    expect(() => readFileSync(join(directory, "CUBICORE_PLAN.json"))).toThrow();
  });

  test("member files collide loudly at plan time when writes overlap", async () => {
    const directory = root();
    const first = await handler()({
      plan: JSON.stringify(memberPlan("1", ["src/shared.ts"])),
      directory,
      planNumber: 1,
    });
    expect(first.isError).not.toBe(true);

    const second = await handler()({
      plan: JSON.stringify(memberPlan("2", ["src/shared.ts"])),
      directory,
      planNumber: 2,
    });
    const text = out(second);
    expect(text).toContain("Cross-plan problems");
    expect(text).toContain("write collision");
    expect(text).toContain("src/shared.ts");
  });

  test("disjoint member slices pass silently", async () => {
    const directory = root();
    await handler()({
      plan: JSON.stringify(memberPlan("1", ["src/alice.ts"])),
      directory,
      planNumber: 1,
    });
    const second = await handler()({
      plan: JSON.stringify(memberPlan("2", ["src/bob.ts"])),
      directory,
      planNumber: 2,
    });
    expect(out(second)).not.toContain("Cross-plan problems");
  });
});

describe("solo plans are untouched by team mode", () => {
  test("plan_write without a planNumber writes the base files with no member header", async () => {
    const directory = root();
    const result = await handler()({
      plan: JSON.stringify(memberPlan("solo", ["src/solo.ts"])),
      directory,
    });
    expect(result.isError).not.toBe(true);
    expect(readFileSync(join(directory, "CUBICORE_PLAN.md"), "utf8")).not.toContain("Member ");
    expect(out(result)).toContain("CUBICORE_PLAN.md");
    expect(out(result)).toContain("plan_coverage");
  });
});

describe("next — team directories still count as planned", () => {
  test("a directory with only member files offers execute, naming the member flow", () => {
    const directory = root();
    writeFileSync(join(directory, "CUBICORE_PLAN_1.json"), "{}");
    const options = nextOptions(directory);
    expect(options[0].step).toBe("execute");
    expect(options[0].note).toContain("<your number>");
  });

  test("an empty directory offers planning as before", () => {
    const directory = root();
    const options = nextOptions(directory);
    expect(options[0].step).toBe("plan-demo");
  });
});

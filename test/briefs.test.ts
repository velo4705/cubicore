import { describe, expect, it } from "bun:test";

import { BRIEF_DIR, briefs, briefPath, renderBrief, renderManifest } from "../src/mcp/inline";
import { parsePlan } from "../src/coordinator/parse";
import type { Contract, Plan } from "../src/contracts/types";

/**
 * One brief per associate. A shared file invites an associate to read another
 * associate's scope, and a fixed frontend/backend/design taxonomy does not
 * survive contact with a CLI, a plugin or a library.
 */

const c = (id: string, writes: string[], forbidden: string[] = []): Contract =>
  ({
    id,
    objective: `Implement ${id} carefully`,
    reads: [],
    writes,
    forbidden,
    deliverable: "diff",
    schema: { type: "object" },
    doneWhen: "it works",
    checks: [
      { id: "k", kind: "intent", command: `bunx --bun tsx -e "assert(true)"`, expectation: "e", gating: "blocking", convergent: true },
    ],
    budget: { tokens: 30_000, toolCalls: 60, wallMs: 120_000 },
  }) as unknown as Contract;

const planOf = (contracts: Contract[]): Plan =>
  parsePlan(
    JSON.stringify({
      topology: "fan-out",
      contracts,
      graphBudget: { nodes: 4, edges: 1, tokens: 120_000, wallMs: 480_000 },
    }),
  ) as Plan;

describe("associate briefs", () => {
  it("writes one file per associate, plus an index", () => {
    const files = briefs(planOf([c("a", ["src/a.ts"]), c("b", ["src/b.ts"])]));
    expect(files).toHaveLength(3);
    expect(files[0].path).toBe(`${BRIEF_DIR}/README.md`);
    expect(files.filter((f) => f.path.endsWith(".md"))).toHaveLength(3);
  });

  it("names files in dispatch order so they sort correctly", () => {
    expect(briefPath(0, "alpha")).toBe(`${BRIEF_DIR}/01-alpha.md`);
    expect(briefPath(9, "alpha")).toBe(`${BRIEF_DIR}/10-alpha.md`);
  });

  it("gives each brief only its own scope", () => {
    const files = briefs(planOf([c("a", ["src/a.ts"], ["src/b.ts"]), c("b", ["src/b.ts"])]));
    const briefA = files.find((f) => f.path.includes("a"))!.content;
    expect(briefA).toContain("`src/a.ts`");
    // b's scope appears only as off-limits, never as a write scope
    expect(briefA).not.toContain("## Your write scope — edit nothing outside this\n\n- `src/b.ts`");
  });

  it("tells an associate not to read the other briefs", () => {
    const md = renderBrief(c("a", ["src/a.ts"]), 0, 3);
    expect(md).toContain("Do not read another associate's brief");
  });

  it("carries the blocking checks the associate must satisfy", () => {
    const md = renderBrief(c("a", ["src/a.ts"]), 0, 1);
    expect(md).toContain("Blocking checks");
    expect(md).toContain("assert(true)");
  });

  it("flags a diff with nothing that can fail rather than passing silently", () => {
    const unverifiable = { ...c("a", ["src/a.ts"]), checks: [] } as unknown as Contract;
    const md = renderBrief(unverifiable, 0, 1);
    expect(md).toContain("not verifiable");
  });

  it("names the project kind when the planner supplied one, and none when it did not", () => {
    const contract = c("a", ["src/a.ts"]);
    expect(renderBrief(contract, 0, 1, { projectKind: "a CLI" })).toContain("a CLI");
    expect(renderBrief(contract, 0, 1)).not.toContain("## Context");
  });

  it("indexes every associate with its scope and brief path", () => {
    const md = renderManifest(planOf([c("a", ["src/a.ts"]), c("b", ["src/b.ts"])]));
    expect(md).toContain("01-a.md");
    expect(md).toContain("02-b.md");
    expect(md).toContain("Dispatch each to the `cubicore-associate` sub-agent");
    expect(md).toContain("a merged report hides which one failed");
  });

  it("does not invent a category system the project may not have", () => {
    const md = renderManifest(planOf([c("parser", ["src/parse.rs"])]), { projectKind: "a Rust CLI" });
    expect(md).toContain("a Rust CLI");
    expect(md).not.toContain("frontend");
    expect(md).not.toContain("backend");
  });
});

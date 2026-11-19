import { describe, expect, test } from "bun:test";

import { renderDebugMd } from "../src/mcp/protocol";
import type { ContractState } from "../src/mcp/runs";
import type { TestFinding } from "../src/mcp/protocol";

const noFindings: TestFinding[] = [];

const ctx = (states: Record<string, ContractState>, failures: Array<{ contractId: string; checkId: string; output: string; kind: string }> = []) => ({
  contracts: Object.keys(states).map((id) => ({ id })),
  states: new Map(Object.entries(states)),
  failures,
});

describe("renderDebugMd — three-tier section output", () => {
  test("with no findings and clean plan: Verified + Next prints pass line", () => {
    const md = renderDebugMd(noFindings, 1, 3, {
      contracts: [{ id: "scaffold" }, { id: "app" }],
      states: new Map([["scaffold", "done"], ["app", "done"]]),
      failures: [] as Array<{ contractId: string; checkId: string; output: string; kind: string }>,
    });

    expect(md).toContain("## Verified");
    expect(md).toContain("✅ scaffold");
    expect(md).toContain("✅ app");
    expect(md).toContain("2/2 verified on disk");
    expect(md).toContain("No blocking findings");
    expect(md).not.toContain("## Blocked / not-verified");
    expect(md).not.toContain("## Escapes");
  });

  test("blocked contracts get a dedicated section with kind tags", () => {
    const md = renderDebugMd([], 1, 3, {
      contracts: [{ id: "image" }],
      states: new Map([["image", "blocked"]]),
      failures: [{ contractId: "image", checkId: "tools.sharp exists", output: "Cannot find package 'sharp'", kind: "environment" }],
    });

    expect(md).toContain("## Blocked / not-verified");
    expect(md).toContain("[environment] tools.sharp exists");
    expect(md).toContain("Cannot find package");
    // Rendered after Verified, so it appears under that section.
    expect(md.indexOf("## Verified")).toBeLessThan(md.indexOf("## Blocked / not-verified"));
  });

  test("failed contracts are sorted first in Verified, with failure count", () => {
    const md = renderDebugMd([], 1, 3, {
      contracts: [{ id: "a" }, { id: "b" }, { id: "c" }],
      states: new Map([["a", "done"], ["b", "failed"], ["c", "done"]]),
      failures: [{ contractId: "b", checkId: "vitest run", output: "FAIL tests/x.spec.ts", kind: "code" }],
    });

    const failedAt = md.indexOf("❌ b");
    const aDoneAt = md.indexOf("✅ a");
    expect(failedAt).toBeLessThan(aDoneAt);
    expect(md).toContain("1 failed");
    expect(md).toContain("1 blocking check");
  });

  test("escapes are printed when supplied", () => {
    const md = renderDebugMd([], 1, 3, {
      contracts: [{ id: "scaffold" }],
      states: new Map([["scaffold", "done"]]),
      failures: [],
      escapes: [{ contractId: "scaffold", files: ["src/secret.ts"] }],
    });
    expect(md).toContain("## Escapes");
    expect(md).toContain("src/secret.ts");
  });

  test("escapes are omitted cleanly when not supplied", () => {
    const md = renderDebugMd([], 1, 3, ctx({ a: "done" }));
    expect(md).not.toContain("## Escapes");
  });

  test("blocking findings coexist with Verified section", () => {
    const md = renderDebugMd(
      [{ severity: "error", source: "x", message: "something is on fire", fix: "put it out" }],
      2,
      3,
      ctx({ a: "done" }),
    );
    expect(md).toContain("## Blocking");
    expect(md).toContain("something is on fire");
    expect(md).toContain("## Verified");
  });

  test("Next section says not every contract verified, when some failed", () => {
    const md = renderDebugMd(
      [],
      1,
      3,
      ctx({ a: "done", b: "failed" }, [{ contractId: "b", checkId: "check", output: "", kind: "code" }]),
    );
    expect(md).toContain("Not every contract verified");
  });
});

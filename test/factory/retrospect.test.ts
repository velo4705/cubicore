import { describe, expect, test } from "bun:test";
import { buildRetrospective, renderRetrospective, type RetroUsage } from "../../src/factory/retrospect";

const usage = (overrides: Partial<RetroUsage> = {}): RetroUsage => ({
  input: 100,
  output: 50,
  cacheRead: 400,
  cacheWrite: 25,
  reasoning: 25,
  ...overrides,
});

describe("retrospective — tokens are measured or honestly unknown", () => {
  test("a null usage renders unknown, never a measured-sounding zero", () => {
    const r = buildRetrospective({
      fit: undefined,
      artifacts: [],
      unresolved: [],
      deferred: 0,
      usage: null,
    });
    expect(r.totalTokens).toBeNull();
    const rendered = renderRetrospective(r);
    expect(rendered).toContain("unknown (inline dispatch — host tokens not collected)");
    expect(rendered).not.toContain("Tokens: 0");
  });

  test("scope escapes are surfaced by name — union-scope evidence stays visible", () => {
    const artifact = {
      contractId: "w1",
      status: "flagged",
      deliverable: "diff",
      changedFiles: ["src/hidden.ts"],
      unresolved: ["w1 — scope: worker modified undeclared path(s): src/hidden.ts"],
      unverified: false,
    };
    const r = buildRetrospective({
      fit: undefined,
      artifacts: [artifact],
      unresolved: ["w1 — scope: worker modified undeclared path(s): src/hidden.ts"],
      deferred: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    });
    expect(r.escapes).toHaveLength(1);
    expect(r.escapes[0].contractId).toBe("w1");
    expect(r.escapes[0].files).toEqual(["src/hidden.ts"]);
    expect(renderRetrospective(r)).toContain("Scope escapes:");
    expect(renderRetrospective(r)).toContain("src/hidden.ts");
  });

  test("a clean run renders no escapes section", () => {
    const r = buildRetrospective({
      fit: undefined,
      artifacts: [],
      unresolved: [],
      deferred: 0,
      usage: null,
    });
    expect(r.escapes).toEqual([]);
    expect(renderRetrospective(r)).not.toContain("Scope escapes:");
  });

  test("visual flag passes through to retrospect output unchanged", () => {
    const r = buildRetrospective({
      fit: undefined,
      artifacts: [],
      unresolved: [],
      deferred: 0,
      usage: null,
      visual: { verdict: "ok", detail: "initial pass" },
    });
    expect(r.visual).toEqual({ verdict: "ok", detail: "initial pass" });
    expect(renderRetrospective(r)).toContain("Visual: ok");
  });

  test("a measured usage sums every billable class — cache counts", () => {
    const r = buildRetrospective({
      fit: undefined,
      artifacts: [],
      unresolved: [],
      deferred: 0,
      usage: usage(),
    });
    expect(r.totalTokens).toBe(600);
    expect(renderRetrospective(r)).toContain("Tokens: 600");
  });
});

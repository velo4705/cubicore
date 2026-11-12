import { describe, expect, test } from "bun:test";
import {
  buildRetrospective,
  renderRetrospective,
  type RetroUsage,
} from "../../src/factory/retrospect";

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

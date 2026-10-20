import { describe, expect, it } from "bun:test";

import { DEFAULT_MODEL, resolveModel } from "../src/mcp/model";

/**
 * A model removed from the provider fails *silently*: the prompt is accepted,
 * the user message is recorded, and no assistant reply ever arrives. Verified
 * on `opencode/space-bunny-free`, which was withdrawn mid-session and left
 * every associate idle until its wall budget expired.
 */

describe("model resolution", () => {
  it("uses the default when the provider lists it", () => {
    const r = resolveModel([DEFAULT_MODEL, "opencode/other"]);
    expect(r.ok).toBe(true);
    expect(r.model).toBe(DEFAULT_MODEL);
    expect(r.reason).toBeUndefined();
  });

  it("honours a preferred model that exists", () => {
    const r = resolveModel(["opencode/a", "opencode/b"], "opencode/b");
    expect(r.ok).toBe(true);
    expect(r.model).toBe("opencode/b");
  });

  it("falls back to a free model when the preferred one is gone", () => {
    const r = resolveModel(["opencode/big-pickle", "opencode/beam-free"], "opencode/space-bunny-free");
    expect(r.ok).toBe(true);
    expect(r.model).toBe("opencode/beam-free");
    expect(r.reason).toContain("not available");
  });

  it("fails loudly when nothing usable is on offer", () => {
    const r = resolveModel(["opencode/paid-only"], "opencode/space-bunny-free");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("space-bunny-free");
    expect(r.reason).toContain("opencode/paid-only");
  });

  it("refuses to guess when the provider lists nothing", () => {
    const r = resolveModel([]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("returned no models");
  });

  it("does not pick a paid model as a fallback", () => {
    const r = resolveModel(["opencode/some-paid"], "opencode/gone");
    expect(r.ok).toBe(false);
  });
});

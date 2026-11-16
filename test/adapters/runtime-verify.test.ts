import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { verifyModel, extractModelIds } from "../../src/adapters/opencode/runtime";
import type { Runtime } from "../../src/adapters/opencode/runtime";

const fakeRuntime = (baseUrl: string): Runtime =>
  ({
    baseUrl,
    model: { id: "opencode/test-model-free", verified: false },
    client: null,
    port: "1",
    directory: "/tmp",
    models: { strong: "opencode/test-model-free", cheap: "opencode/test-model-free" },
  }) as unknown as Runtime;

const realFetch = globalThis.fetch;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const serve = (table: Record<string, () => Response>) => {
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const handler = table[url.pathname];
    if (!handler) return new Response("not found", { status: 404 });
    return handler();
  }) as unknown as typeof fetch;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const html = () =>
  new Response("<html><title>opencode</title></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });

describe("extractModelIds — every shape the host has served decodes", () => {
  test("Shape 1: { all: [...] }", () => {
    const ids = extractModelIds({ all: [{ id: "opencode", models: { "opencode/a-free": {}, b: {} } }] });
    expect(ids).toEqual(["opencode/a-free", "opencode/b"]);
  });

  test("Shape 2: { providers: [...] }", () => {
    const ids = extractModelIds({ providers: [{ id: "opencode", models: { "opencode/x": {} } }] });
    expect(ids).toEqual(["opencode/x"]);
  });

  test("Shape 2b: top-level array of providers", () => {
    const ids = extractModelIds([{ id: "opencode", models: { y: {} } }]);
    expect(ids).toEqual(["opencode/y"]);
  });

  test("Shape 3: keyed by provider id with full model keys", () => {
    const ids = extractModelIds({ opencode: { models: { "opencode/full-id": {} } } });
    expect(ids).toEqual(["opencode/full-id"]);
  });

  test("Shape 3b: flat { models: {...} } with full keys", () => {
    const ids = extractModelIds({ models: { "opencode/flat": {}, "other/thing": {} } });
    expect(ids).toEqual(["opencode/flat", "other/thing"]);
  });

  test("unknown payload → no ids, never a wrong guess", () => {
    expect(extractModelIds({ unrelated: true })).toEqual([]);
    expect(extractModelIds("<html>")).toEqual([]);
    expect(extractModelIds(null)).toEqual([]);
  });
});

describe("verifyModel — probe every endpoint, tolerate every known shape", () => {
  test("/provider answers in Shape 1: verified", async () => {
    serve({ "/provider": () => json({ all: [{ id: "opencode", models: { "opencode/test-model-free": {} } }] }) });
    const result = await verifyModel(fakeRuntime("http://host"));
    expect(result.verified).toBe(true);
    expect(calls).toEqual(["/provider"]);
  });

  test("/provider is HTML but /config/providers has the list: falls back and verifies", async () => {
    serve({
      "/provider": html,
      "/config/providers": () =>
        json({ providers: [{ id: "opencode", models: { "opencode/test-model-free": {} } }] }),
    });
    const result = await verifyModel(fakeRuntime("http://host"));
    expect(result.verified).toBe(true);
    expect(calls).toEqual(["/provider", "/config/providers"]);
  });

  test("all endpoints broken: unverified, reason names every attempt", async () => {
    serve({ "/provider": html, "/config/providers": () => new Response("x", { status: 404 }), "/config": html });
    const result = await verifyModel(fakeRuntime("http://host"));
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("/provider");
    expect(result.reason).toContain("/config/providers");
    expect(result.reason).toContain("/config");
    expect(result.reason).toContain("/api/provider");
  });

  test("JSON with an unrecognised shape: unverified, says so", async () => {
    serve({ "/provider": () => json({ weird: true }), "/config/providers": () => json({ weird: true }), "/config": () => json({ weird: true }) });
    const result = await verifyModel(fakeRuntime("http://host"));
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("no model list");
  });

  test("wanted model absent but a free fallback exists: verified with a fallback reason", async () => {
    serve({
      "/provider": () => json({ all: [{ id: "opencode", models: { "opencode/some-other-free": {} } }] }),
    });
    const result = await verifyModel(fakeRuntime("http://host"), "opencode/missing-model");
    expect(result.verified).toBe(true);
    expect(result.id).toBe("opencode/some-other-free");
    expect(result.reason).toContain("not available");
  });
});

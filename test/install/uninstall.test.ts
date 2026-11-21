import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectInstalledTargets, uninstall } from "../../src/install/uninstall";
import type { ResolveOptions } from "../../src/install/targets";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cubicore-uninstall-"));
  roots.push(root);
  const nativeDir = join(root, ".config", "opencode");
  const flatpakDir = join(root, ".var", "app", "ai.opencode.opencode", "config", "opencode");
  mkdirSync(nativeDir, { recursive: true });
  mkdirSync(flatpakDir, { recursive: true });
  const native = join(nativeDir, "opencode.json");
  const flatpak = join(flatpakDir, "opencode.json");
  writeFileSync(native, JSON.stringify({
    mcp: { "founder-mcp": { type: "local" }, cubicore: { type: "local", command: ["bun", "x"] } },
    agent: {
      build: { maxSteps: 120, prompt: "founder's own" },
      "cubicore-associate": { mode: "subagent" },
      "cubicore-research": { mode: "subagent" },
    },
    plugin: ["founder-plugin"],
  }, null, 2));
  writeFileSync(flatpak, JSON.stringify({
    mcp: { cubicore: { type: "local" }, "other": { type: "local" } },
    agent: { "cubicore-associate": { mode: "subagent" } },
  }, null, 2));
  const opts: ResolveOptions = {
    platform: "linux",
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, ".config") },
    home: root,
    exists: existsSync,
  };
  return { root, native, flatpak, opts };
}

describe("uninstall — both variants", () => {
  test("detects native and flatpak independently", () => {
    const { opts } = fixture();
    expect(detectInstalledTargets(opts).map((t) => t.id)).toEqual(["native", "flatpak"]);
  });

  test("no flag removes Cubicore marks from both configs", () => {
    const { native, flatpak, opts } = fixture();
    const result = uninstall(opts);
    expect(result.targets).toHaveLength(2);
    expect(result.targets.every((t) => t.changed)).toBe(true);

    const n = JSON.parse(readFileSync(native, "utf8"));
    expect(n.mcp.cubicore).toBeUndefined();
    expect(n.mcp["founder-mcp"]).toBeDefined();
    expect(n.agent["cubicore-associate"]).toBeUndefined();
    expect(n.agent["cubicore-research"]).toBeUndefined();
    expect(n.agent.build.maxSteps).toBe(120);
    expect(n.agent.build.prompt).toBe("founder's own");
    expect(n.plugin).toEqual(["founder-plugin"]);

    const f = JSON.parse(readFileSync(flatpak, "utf8"));
    expect(f.mcp.cubicore).toBeUndefined();
    expect(f.mcp.other).toBeDefined();
    expect(f.agent["cubicore-associate"]).toBeUndefined();
  });

  test("--native leaves the flatpak install intact", () => {
    const { native, flatpak, opts } = fixture();
    uninstall(opts, "native");
    const n = JSON.parse(readFileSync(native, "utf8"));
    const f = JSON.parse(readFileSync(flatpak, "utf8"));
    expect(n.mcp.cubicore).toBeUndefined();
    expect(f.mcp.cubicore).toBeDefined();
  });

  test("--flatpak leaves the native install intact", () => {
    const { native, flatpak, opts } = fixture();
    uninstall(opts, "flatpak");
    expect(JSON.parse(readFileSync(native, "utf8")).mcp.cubicore).toBeDefined();
    expect(JSON.parse(readFileSync(flatpak, "utf8")).mcp.cubicore).toBeUndefined();
  });

  test("idempotent — a second pass reports nothing to remove", () => {
    const { opts } = fixture();
    uninstall(opts);
    const second = uninstall(opts);
    expect(second.targets).toHaveLength(0);
    expect(detectInstalledTargets(opts)).toHaveLength(0);
  });

  test("keeps the uninstall backup beside each config", () => {
    const { native, opts } = fixture();
    uninstall(opts);
    expect(existsSync(`${native}.cubicore-uninstall.bak`)).toBe(true);
  });

  test("removes the version stamp next to a config", () => {
    const { native, opts } = fixture();
    const stamp = join(native, "..", ".cubicore-version");
    writeFileSync(stamp, '{"version":"1.1.13"}');
    uninstall(opts);
    expect(existsSync(stamp)).toBe(false);
  });
});

import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { introspectProject, writeStateSnapshot } from "../../src/project/introspect";

const roots: string[] = [];
const root = () => {
  const directory = mkdtempSync(join(tmpdir(), "cubicore-introspect-"));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});

describe("introspectProject", () => {
  test("always returns a valid snapshot shape", () => {
    const dir = root();
    const snap = introspectProject(dir);
    expect(snap.schemaVersion).toBe(1);
    expect(snap.host.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.host.node).toContain("v");
    expect(typeof snap.host.platform).toBe("string");
    expect(typeof snap.host.nodeModulesPresent).toBe("boolean");
    expect(Array.isArray(snap.playwrightBrowsers)).toBe(true);
    expect(snap.nativeDeps).toHaveProperty("sharp");
    expect(snap.nativeDeps.sharp).toHaveProperty("declared");
    expect(snap.nativeDeps.sharp).toHaveProperty("installed");
  });

  test("detects native declarations and presence in a fixture project", () => {
    const dir = root();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { sharp: "^0.33.0" }, devDependencies: { "better-sqlite3": "^11.3.0" } }),
    );
    // node_modules not created — should mark declared, not installed
    const snap1 = introspectProject(dir);
    expect(snap1.nativeDeps.sharp.declared).toBe(true);
    expect(snap1.nativeDeps.sharp.installed).toBe(false);
    expect(snap1.nativeDeps["better-sqlite3"].declared).toBe(true);
    expect(snap1.nativeDeps["better-sqlite3"].installed).toBe(false);

    // after creating node_modules/sharp, installed should flip
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "node_modules", "sharp"), { recursive: true });
    const snap2 = introspectProject(dir);
    expect(snap2.nativeDeps.sharp.declared).toBe(true);
    expect(snap2.nativeDeps.sharp.installed).toBe(true);
  });

  test("reports an empty declared-dep situation gracefully", () => {
    const dir = root();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    const snap = introspectProject(dir);
    expect(snap.nativeDeps.sharp.declared).toBe(false);
    expect(snap.nativeDeps.sharp.installed).toBe(false);
  });

  test("writes the snapshot to disk and returns the path", () => {
    const dir = root();
    const path = writeStateSnapshot(dir);
    expect(path).toBeTruthy();
    const body = readFileSync(path!, "utf8");
    const parsed = JSON.parse(body);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.host.node).toBeTypeOf("string");
  });

  test("nativeDeps detects node_modules present but absent from package.json", () => {
    const dir = root();
    // no package.json at all; node_modules present with sharp inside
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(dir, "node_modules", "sharp"), { recursive: true });
    const snap = introspectProject(dir);
    expect(snap.host.nodeModulesPresent).toBe(true);
    // No package.json → not declared; but installed is true because the dir exists
    expect(snap.nativeDeps.sharp.declared).toBe(false);
    expect(snap.nativeDeps.sharp.installed).toBe(true);
  });
});

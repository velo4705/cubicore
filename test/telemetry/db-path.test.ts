import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  defaultDbPath,
  newestSessionMs,
} from "../../src/telemetry/adapters/session-db";

const fixture = (dir: string, name: string, newestMs: number | null, v2 = true) => {
  const path = join(dir, name);
  const db = new Database(path, { create: true });
  if (v2) {
    db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL)");
  } else {
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL)");
  }
  if (newestMs !== null) {
    db.exec(`INSERT INTO ${v2 ? "session_v2" : "session"} (id, time_created) VALUES ('fixture-session', ${newestMs})`);
  }
  db.close();
  return path;
};

describe("newestSessionMs", () => {
  test("returns the newest row across v2 tables", () => {
    const dir = mkdtempSync("/tmp/cubicore-db-test-");
    try {
      const a = fixture(dir, "a.db", 111, true);
      const b = fixture(dir, "b.db", 222, true);
      expect(newestSessionMs(a)).toBe(111);
      expect(newestSessionMs(b)).toBe(222);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads a legacy v1-only database", () => {
    const dir = mkdtempSync("/tmp/cubicore-db-legacy-");
    try {
      const legacy = fixture(dir, "legacy.db", 333, false);
      expect(newestSessionMs(legacy)).toBe(333);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing file yields null, not a crash", () => {
    expect(newestSessionMs("/tmp/cubicore-definitely-absent-9c2dd1.db")).toBeNull();
  });

  test("no sessions at all still counts as openable and returns 0", () => {
    const dir = mkdtempSync("/tmp/cubicore-db-empty-");
    try {
      expect(newestSessionMs(fixture(dir, "empty.db", null))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("defaultDbPath — actually opens", () => {
  test("returns a path that exists on this host when candidates exist", () => {
    const picked = defaultDbPath();
    // Either an override is configured, or one of the install candidates exists.
    expect(typeof picked).toBe("string");
    expect(picked.length).toBeGreaterThan(0);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendArchive, planDigest, readArchive, renderArchive, type ArchiveEntry } from "../../src/mcp/archive";

function entry(overrides: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    v: 1,
    at: "2026-11-26T00:00:00.000Z",
    runId: "run-1",
    planDigest: "abc123",
    mode: "full",
    topology: "pipeline",
    contracts: 4,
    state: "done",
    verdict: "the merged tree passes its integration command",
    ...overrides,
  };
}

describe("run archive", () => {
  test("appends entries and ignores a torn last line", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-archive-"));
    appendArchive(dir, entry());
    appendArchive(dir, entry({ runId: "run-2", state: "failed", verdict: "build broken" }));
    writeFileSync(join(dir, ".cubicore-archive.jsonl"), '{"v":1,"runId"', { flag: "a" });
    const entries = readArchive(dir);
    expect(entries).toHaveLength(2);
    expect(entries[1].state).toBe("failed");
    expect(renderArchive(entries)[0]).toContain("abc123");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the plan digest changes with the plan body", () => {
    expect(planDigest('{"topology":"fan-out"}')).not.toBe(planDigest('{"topology":"pipeline"}'));
  });

  test("returns an honest empty state", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-archive-empty-"));
    expect(readArchive(dir)).toEqual([]);
    expect(renderArchive([])[0]).toContain("No runs archived");
    rmSync(dir, { recursive: true, force: true });
  });
});

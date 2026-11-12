import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearEscalations,
  escalatedLine,
  readEscalations,
  recordEscalations,
} from "../../src/factory/escalations";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cubicore-escal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BLOCKED = [
  { contractId: "ui", checkId: "deps-installed", reason: "fatal: npx: command not found" },
  { contractId: "ui-smoke", checkId: "playwright-smoke", reason: "Error: browser binary missing" },
];

describe("escalations — blocked means recorded, not retried forever", () => {
  test("records the snapshot and reads it back", () => {
    recordEscalations(dir, BLOCKED);
    expect(existsSync(join(dir, ".cubicore-escalations.json"))).toBe(true);
    const back = readEscalations(dir);
    expect(back.map((e) => e.contractId)).toEqual(["ui", "ui-smoke"]);
    expect(back[0].attempts).toBe(1);
    expect(back[0].nextAction).toContain("install the missing tool");
  });

  test("attempts counts cycles across verify rounds — the honest bound", () => {
    recordEscalations(dir, BLOCKED);
    const second = recordEscalations(dir, BLOCKED);
    expect(second[0].attempts).toBe(2);
    expect(second[1].attempts).toBe(2);
  });

  test("a contract that clears stops being escalated — the file is a snapshot, not an accumulator", () => {
    recordEscalations(dir, BLOCKED);
    recordEscalations(dir, [BLOCKED[0]]);
    const back = readEscalations(dir);
    expect(back.map((e) => e.contractId)).toEqual(["ui"]);
    expect(back[0].attempts).toBe(2);
  });

  test("zero escalated contracts deletes the snapshot — absence is the desired state", () => {
    recordEscalations(dir, BLOCKED);
    clearEscalations(dir);
    expect(existsSync(join(dir, ".cubicore-escalations.json"))).toBe(false);
    expect(escalatedLine(dir)).toBeNull();
  });

  test("a stale empty history file does not survive a start-fresh pass", () => {
    writeFileSync(join(dir, ".cubicore-escalations.json"), "garbage");
    expect(readEscalations(dir)).toEqual([]);
  });

  test("status line names each escalated contract with one next action", () => {
    recordEscalations(dir, BLOCKED);
    const line = escalatedLine(dir);
    expect(line).toContain("Escalated (2)");
    expect(line).toContain("ui-smoke");
    expect(line).toContain("install the missing tool");
  });
});

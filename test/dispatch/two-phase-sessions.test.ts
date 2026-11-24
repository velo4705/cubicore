import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerSessions, type SessionSpawner } from "../../src/dispatch/spawn";
import { createWorktree, refreshWorktree } from "../../src/dispatch/worktree";
import type { Contract } from "../../src/contracts/types";

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "consumer",
    objective: "use the shared type",
    reads: ["src/dep.ts"],
    writes: ["src/out.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: {},
    doneWhen: "it builds",
    checks: [],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 5000 },
    ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cubicore-two-phase-"));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/dep.ts"), "export const value = 1;\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

describe("two-phase worker sessions", () => {
  test("prepare creates the child session; the brief is sent only by start", async () => {
    let created = 0;
    let prompted = 0;
    const spawner: SessionSpawner = {
      async create() {
        created++;
        return { sessionId: "ses_prepared" };
      },
      async prompt() {
        prompted++;
      },
      async changedFiles() {
        return [];
      },
    };
    // No isolation and an immediate idle probe: this test is about call order.
    const sessions = new WorkerSessions(spawner, undefined, undefined, undefined, undefined, process.cwd(), undefined, false, () => ({
      idle: true,
      outcome: "succeeded",
    }));

    const handle = await sessions.prepare(contract());
    expect(handle.contractId).toBe("consumer");
    expect(created).toBe(1);
    expect(prompted).toBe(0);

    await sessions.start(handle, contract());
    expect(prompted).toBe(1);
  });

  test("a held worker gets prerequisite files that landed after its session was created", async () => {
    const root = tempRepo();
    const worktree = createWorktree(root, contract());
    expect(worktree.degraded).toBe(false);
    expect(readFileSync(join(worktree.path, "src/dep.ts"), "utf8")).toContain("value = 1");

    // The producer finished and its work was collected into the shared root.
    writeFileSync(join(root, "src/dep.ts"), "export const value = 2;\n");
    const copied = refreshWorktree(worktree, root, contract());

    expect(copied).toContain("src/dep.ts");
    expect(readFileSync(join(worktree.path, "src/dep.ts"), "utf8")).toContain("value = 2");

    // The refreshed prerequisite is re-baselined, so it must not look like a
    // change made by this worker.
    const diff = spawnSync("git", ["status", "--porcelain"], { cwd: worktree.path, encoding: "utf8" });
    expect(diff.stdout.trim()).toBe("");
  });
});


test("the host-state hint is appended to the worker brief", async () => {
  let sent = "";
  const sessions = new WorkerSessions(
    {
      async create() { return { sessionId: "ses_state" }; },
      async prompt(_id, input) { sent = input.text; },
      async changedFiles() { return []; },
    },
    undefined, undefined, undefined, undefined, process.cwd(), undefined, false,
    () => ({ idle: true, outcome: "succeeded" }),
  );
  sessions.hostState = "# Host state already checked\nnpm: 11";
  const handle = await sessions.prepare(contract());
  await sessions.start(handle, contract());
  expect(sent).toContain("# Objective");
  expect(sent).toContain("# Host state already checked");
  expect(sent).toContain("npm: 11");
});

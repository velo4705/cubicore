import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectWorktree, createWorktree, removeWorktree } from "../src/dispatch/worktree";
import type { Contract } from "../src/contracts/types";

/**
 * The plan guarantees the scopes are disjoint, and the scope gate catches a
 * worker that strays. Neither prevents anything: until the gate runs, two
 * workers share one directory and can be in the same file at the same moment.
 *
 * opencode 1.18.x cannot prevent it either -- its agent permissions are V1,
 * with edit as ask/allow/deny and no path granularity. So the boundary has to
 * be the filesystem: a worktree per associate.
 */

const contract = (id: string, writes: string[]): Contract =>
  ({
    id,
    objective: "Do the thing",
    reads: [],
    writes,
    forbidden: [],
    deliverable: "diff",
    schema: { type: "object" },
    doneWhen: "done",
    checks: [],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
  }) as unknown as Contract;

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "cubicore-wt-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "src", "shared.ts"), "export const shared = 0;\n");
  writeFileSync(join(root, "package.json"), '{"name":"wt","private":true}\n');
  const { execSync } = require("node:child_process");
  execSync("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m base", { cwd: root });
  return root;
};

describe("one worktree per associate", () => {
  it("gives two associates different directories", () => {
    const root = repo();
    const a = createWorktree(root, contract("a", ["src/a.ts"]));
    const b = createWorktree(root, contract("b", ["src/b.ts"]));

    expect(a.degraded).toBe(false);
    expect(b.degraded).toBe(false);
    expect(a.path).not.toBe(b.path);
    expect(a.path).not.toBe(root);
    removeWorktree(a, root);
    removeWorktree(b, root);
  });

  it("keeps two workers in the same file from colliding", () => {
    const root = repo();
    const a = createWorktree(root, contract("a", ["src/shared.ts"]));
    const b = createWorktree(root, contract("b", ["src/shared.ts"]));

    // The same file, two directories. One writes it; the other cannot see it.
    writeFileSync(join(a.path, "src", "shared.ts"), "written by a\n");
    expect(readFileSync(join(a.path, "src", "shared.ts"), "utf8")).toBe("written by a\n");
    expect(readFileSync(join(b.path, "src", "shared.ts"), "utf8")).not.toBe("written by a\n");

    removeWorktree(a, root);
    removeWorktree(b, root);
  });

  it("copies the work back to the main tree", () => {
    const root = repo();
    const a = createWorktree(root, contract("a", ["src/a.ts"]));
    writeFileSync(join(a.path, "src", "a.ts"), "export const a = 42;\n");

    const result = collectWorktree(a, root);
    expect(result.copied).toContain("src/a.ts");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("42");

    removeWorktree(a, root);
  });

  it("degrades honestly when the project is not a repository", () => {
    const root = mkdtempSync(join(tmpdir(), "cubicore-nogit-"));
    const a = createWorktree(root, contract("a", ["src/a.ts"]));
    expect(a.degraded).toBe(true);
    expect(a.reason).toContain("not a git repository");
    // And it still runs, in the shared tree -- but says so.
    expect(a.path).toBe(root);
  });

  it("removes the worktree and its branch afterwards", () => {
    const root = repo();
    const a = createWorktree(root, contract("a", ["src/a.ts"]));
    expect(existsSync(a.path)).toBe(true);
    removeWorktree(a, root);
    expect(existsSync(a.path)).toBe(false);
  });
});

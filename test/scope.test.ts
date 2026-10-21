import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gateScope } from "../src/gate";
import { changedFilesSince, isRepository, prepareRepository } from "../src/dispatch/changes";
import type { Contract } from "../src/contracts/types";

/**
 * The scope gate was passing because it learned nothing.
 *
 * opencode's session.diff returns an empty list, so changedFiles was empty,
 * so the filter found no strays, so the gate returned "all 0 changed file(s)
 * inside declared writes" -- a green light meaning nothing. Every "scope: ok"
 * ever reported was vacuous.
 */

const contract = (over: Partial<Contract> = {}): Contract =>
  ({
    id: "w1",
    objective: "o",
    reads: [],
    writes: ["src/a.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: {},
    doneWhen: "d",
    checks: [],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    ...over,
  }) as unknown as Contract;

describe("the scope gate does not pass on ignorance", () => {
  it("fails when the changes could not be determined", () => {
    const result = gateScope(
      { artifact: { contractId: "w1", deliverable: "diff", raw: "x" }, contract: contract() },
      { changedFiles: [], changesUnknown: true },
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("could not determine");
  });

  it("fails a diff deliverable that changed nothing", () => {
    const result = gateScope(
      { artifact: { contractId: "w1", deliverable: "diff", raw: "x" }, contract: contract() },
      { changedFiles: [] },
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("changed no files");
  });

  it("passes when files changed and all are in scope", () => {
    const result = gateScope(
      { artifact: { contractId: "w1", deliverable: "diff", raw: "x" }, contract: contract() },
      { changedFiles: ["src/a.ts"] },
    );
    expect(result.passed).toBe(true);
  });

  it("fails when a file outside the scope changed", () => {
    const result = gateScope(
      { artifact: { contractId: "w1", deliverable: "diff", raw: "x" }, contract: contract() },
      { changedFiles: ["src/a.ts", "src/other.ts"] },
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("src/other.ts");
  });

  it("does not demand changes from a contract that produces a report", () => {
    const result = gateScope(
      { artifact: { contractId: "w1", deliverable: "report", raw: "x" }, contract: contract({ deliverable: "report" }) },
      { changedFiles: [] },
    );
    expect(result.passed).toBe(true);
  });
});

describe("changed files from git", () => {
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "cubicore-git-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    return root;
  };

  it("reports unknown when the directory is not a repository", () => {
    const result = changedFilesSince(repo());
    expect(result.unknown).toBe(true);
  });

  it("initialises a repository and makes a baseline", () => {
    const root = repo();
    const result = prepareRepository(root);
    expect(result.initialised).toBe(true);
    expect(result.committed).toBe(true);
    expect(isRepository(root)).toBe(true);
  });

  it("never touches a repository that already exists", () => {
    const root = repo();
    prepareRepository(root);
    const before = changedFilesSince(root);
    const second = prepareRepository(root);
    expect(second.alreadyInitialised).toBe(true);
    expect(second.initialised).toBe(false);
    expect(second.committed).toBe(false);
    // And it did not stage or commit anything.
    expect(changedFilesSince(root).files).toEqual(before.files);
  });

  it("reports the files that changed after the baseline", () => {
    const root = repo();
    const prepared = prepareRepository(root);
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
    const changed = changedFilesSince(root, prepared.baseline);
    expect(changed.unknown).toBe(false);
    expect(changed.files.join(" ")).toContain("src/b.ts");
  });
});

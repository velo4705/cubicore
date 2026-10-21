import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveBaseline, STRICT_TS_FLAGS } from "../src/validate/baseline";
import { effectiveMatrix, assertBaselineIntact } from "../src/validate/matrix";

/**
 * The baseline was always empty.
 *
 * D9 says the matrix is a union: baseline from the project, contract checks
 * may only add, and on duplicate commands the baseline wins. The plumbing
 * existed and nothing ever supplied a baseline, so the union was the
 * contract's own checks and "the baseline wins" had nothing to win against.
 *
 * A real run showed the consequence: a plan's project-wide typecheck named no
 * flags, so it ran under the project's lax tsconfig, and an unused parameter
 * passed every check in the matrix.
 */

const project = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "cubicore-base-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
};

describe("baseline derivation", () => {
  it("checks TypeScript strictly, with the flags named rather than inherited", () => {
    const root = project({ "package.json": '{"name":"x","type":"module"}', "tsconfig.json": "{}" });
    const baseline = deriveBaseline(root);
    const typecheck = baseline.find((c) => c.id === "baseline-typecheck-strict");

    expect(typecheck).toBeDefined();
    // The flags are named in the command, which is the whole point.
    expect(typecheck!.command).toContain("--noUnusedLocals");
    expect(typecheck!.command).toContain("--noUnusedParameters");
    expect(typecheck!.command).toContain("--strict");
  });

  it("includes the flags a lax project config would have hidden", () => {
    const root = project({ "package.json": '{"name":"x"}', "tsconfig.json": '{"compilerOptions":{}}' });
    const command = deriveBaseline(root).find((c) => c.id === "baseline-typecheck-strict")!.command;
    for (const flag of STRICT_TS_FLAGS) {
      expect(command).toContain(flag);
    }
  });

  it("adds the project's own scripts as baseline checks", () => {
    const root = project({
      "package.json": '{"name":"x","scripts":{"test":"node --test","lint":"biome check","build":"tsc"}}',
      "tsconfig.json": "{}",
    });
    const ids = deriveBaseline(root).map((c) => c.id);
    expect(ids).toContain("baseline-test-suite");
    expect(ids).toContain("baseline-lint");
    expect(ids).toContain("baseline-build");
  });

  it("invents nothing for a project that has none of it", () => {
    const root = project({ "package.json": '{"name":"x"}' });
    const ids = deriveBaseline(root).map((c) => c.id);
    expect(ids).not.toContain("baseline-test-suite");
    expect(ids).not.toContain("baseline-lint");
  });

  it("returns nothing for a directory that is not a project", () => {
    expect(deriveBaseline(mkdtempSync(join(tmpdir(), "cubicore-empty-")))).toHaveLength(0);
  });
});

describe("the baseline wins", () => {
  it("a contract cannot dilute the strict typecheck", () => {
    const root = project({ "package.json": '{"name":"x","scripts":{"test":"node --test"}}', "tsconfig.json": "{}" });
    const baseline = deriveBaseline(root);

    // A contract that tries to check the project with a lax command.
    const contractChecks = [
      {
        id: "project-typecheck",
        kind: "baseline" as const,
        command: "npm exec --no -- tsc --noEmit",
        expectation: "typechecks",
        gating: "blocking" as const,
        convergent: true,
      },
    ];

    const matrix = effectiveMatrix(baseline, contractChecks);
    const strict = matrix.find((c) => c.command.includes("--noUnusedLocals"));
    expect(strict).toBeDefined();
    // And the contract's lax version did not replace it.
    expect(matrix.filter((c) => c.command.includes("tsc")).length).toBeGreaterThan(1);
  });

  it("a contract that drops the baseline entirely is rejected", () => {
    const root = project({ "package.json": '{"name":"x","scripts":{"test":"node --test"}}', "tsconfig.json": "{}" });
    const baseline = deriveBaseline(root);
    const present = baseline.map((c) => c.command);
    expect(assertBaselineIntact(baseline, baseline)).toHaveLength(0);

    const dropped = assertBaselineIntact(baseline, baseline.slice(1));
    expect(dropped).toHaveLength(1);
    expect(dropped[0].code).toBe("baseline-dropped");
  });
});

import { afterEach, describe, expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildEvidence,
  checkEvidence,
  extractEvidencePaths,
} from "../../src/validate/evidence";
import type { Plan } from "../../src/contracts/types";

const planOf = (checksCommands: string[][]): Plan =>
  ({
    topology: "fan-out",
    contracts: checksCommands.map((cmds, i) => ({
      id: `c${i + 1}`,
      objective: "do the thing",
      reads: [],
      writes: [`src/c${i + 1}.ts`],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "done",
      checks: cmds.map((command, j) => ({
        id: `k${j}`,
        kind: "intent",
        command,
        expectation: "exit 0",
        gating: "blocking",
        convergent: true,
      })),
      budget: { tokens: 1, toolCalls: 1, wallMs: 1000 },
    })),
    graphBudget: { nodes: checksCommands.length, edges: 0, tokens: 1, wallMs: 1000 },
  }) as unknown as Plan;

const roots: string[] = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "cubicore-evidence-"));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

describe("extractEvidencePaths", () => {
  test("pulls the file(s) a command judges, not the tool invocations", () => {
    const found = extractEvidencePaths("npx playwright test -c playwright.config.ts tests/ui-smoke.spec.ts");
    expect(found).toContain("playwright.config.ts");
    expect(found).toContain("tests/ui-smoke.spec.ts");
    expect(found).not.toContain("npx");
    expect(found).not.toContain("playwright");
    expect(found).not.toContain("test");
  });

  test("finds package.json regardless of position", () => {
    const found = extractEvidencePaths("npm run build");
    expect(found).toContain("package.json");
  });

  test("bare single-word commands have no evidence files", () => {
    expect(extractEvidencePaths("true")).toEqual([]);
    expect(extractEvidencePaths("false")).toEqual([]);
  });
});

describe("buildEvidence + checkEvidence", () => {
  test("a sealed tree verifies clean", () => {
    const dir = root();
    writeFileSync(join(dir, "playwright.config.ts"), "export default {}");
    writeFileSync(join(dir, "package.json"), "{}");
    const plan = planOf([["npx playwright test -c playwright.config.ts"]]);

    buildEvidence(dir, plan);

    const result = checkEvidence(dir, plan);
    expect(result.problems).toEqual([]);
  });

  test("a sealed check file modified after acceptance is caught", () => {
    const dir = root();
    writeFileSync(join(dir, "playwright.config.ts"), "original");
    const plan = planOf([["npx playwright test -c playwright.config.ts"]]);

    buildEvidence(dir, plan);
    writeFileSync(join(dir, "playwright.config.ts"), "rewritten to pass");

    const result = checkEvidence(dir, plan);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems[0]).toContain("evidence modified");
    expect(result.problems[0]).toContain("playwright.config.ts");
  });

  test("a package.json dependencies edit after acceptance does NOT trip the seal", () => {
    const dir = root();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "a", dependencies: { three: "^0.1.0" } }));
    const plan = planOf([["npm ls three"]]);

    buildEvidence(dir, plan);

    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "a", dependencies: { three: "^0.2.0", vite: "^5.0.0" } }));
    const result = checkEvidence(dir, plan);
    expect(result.problems).toEqual([]);
  });

  test("a package.json #scripts edit after acceptance is caught", () => {
    const dir = root();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "a", scripts: { build: "vite build", test: "vitest" } }),
    );
    const plan = planOf([["npm run build"]]);

    buildEvidence(dir, plan);

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "a", scripts: { build: "echo ok", test: "vitest" } }),
    );
    const result = checkEvidence(dir, plan);
    expect(result.problems.some((p) => p.includes("package.json#scripts"))).toBe(true);
  });

  test("the plan's checks being rewritten is caught", () => {
    const dir = root();
    writeFileSync(join(dir, "package.json"), "{}");
    const plan = planOf([["npm run build"]]);

    buildEvidence(dir, plan);

    const plan2 = planOf([["npm run build --mode=lenient"]]);
    const result = checkEvidence(dir, plan2);
    expect(result.problems.some((p) => p.includes("checks changed"))).toBe(true);
  });

  test("a file that did not exist at seal time but appears during the run does not block", () => {
    const dir = root();
    // No files yet — playwright.config.ts will be created by a contract later.
    const plan = planOf([["npx playwright test -c playwright.config.ts"]]);

    buildEvidence(dir, plan);

    writeFileSync(join(dir, "playwright.config.ts"), "created by contract");
    const result = checkEvidence(dir, plan);
    expect(result.problems).toEqual([]);
    expect(result.appeared).toContain("playwright.config.ts");
  });

  test("a sealed file that disappears blocks verification", () => {
    const dir = root();
    writeFileSync(join(dir, "package.json"), "{}");
    const plan = planOf([["npm run build"]]);

    buildEvidence(dir, plan);
    rmSync(join(dir, "package.json"));

    const result = checkEvidence(dir, plan);
    expect(result.problems.some((p) => p.includes("missing"))).toBe(true);
  });

  test("a file absent at seal, created mid-run, then rewritten, is caught at re-verify", () => {
    const dir = root();
    const plan = planOf([["npx playwright test tests/ui-smoke.spec.ts"]]);

    buildEvidence(dir, plan);

    // Contract creates the spec mid-run.
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "ui-smoke.spec.ts"), "expect(page.locator('.world')).toBeVisible()");

    // Verify 1: clean + enrollment persists
    const first = checkEvidence(dir, plan);
    expect(first.problems).toEqual([]);
    expect(first.appeared).toContain("tests/ui-smoke.spec.ts");

    // Orchestrator rewrites the spec to a vacuous assertion.
    writeFileSync(join(dir, "tests", "ui-smoke.spec.ts"), "expect(true).toBe(true)");

    // Verify 2: the rewrite is caught as evidence modification
    const second = checkEvidence(dir, plan);
    expect(second.problems.some((p) => p.includes("evidence modified"))).toBe(true);
    expect(second.problems.some((p) => p.includes("ui-smoke.spec.ts"))).toBe(true);
  });

  test("no seal on disk is neither a failure nor a silence", () => {
    const dir = root();
    const plan = planOf([["true"]]);
    const result = checkEvidence(dir, plan);
    expect(result.problems).toEqual([]);
    expect(result.appeared).toEqual([]);
  });
});

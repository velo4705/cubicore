import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { questionsFrom, survey } from "../src/plan/survey";

/**
 * Clarify has to read before it asks. A founder who cannot name their own files
 * cannot answer "which modules?", and a guess becomes a contract that claims
 * everything.
 */

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "cubicore-survey-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test", lint: "biome check" } }));
  writeFileSync(join(root, "src", "billing.ts"), "export function charge(n: number) { return n * 2; }\nexport class Ledger {}\n");
  writeFileSync(join(root, "src", "auth.ts"), "export function login() { return true; }\n");
  writeFileSync(join(root, "src", "auth.test.ts"), "test('login', () => {});\n");
  writeFileSync(join(root, "node_modules", "junk.js"), "ignored");
  return root;
};

describe("survey", () => {
  it("finds the modules that could become write scopes", () => {
    const s = survey(fixture());
    const paths = s.modules.map((m) => m.path);
    expect(paths).toContain(join("src", "billing.ts"));
    expect(paths).toContain(join("src", "auth.ts"));
  });

  it("reads exported names so the founder can be asked about real symbols", () => {
    const s = survey(fixture());
    const billing = s.modules.find((m) => m.path.endsWith("billing.ts"));
    expect(billing?.exports).toContain("charge");
    expect(billing?.exports).toContain("Ledger");
  });

  it("classifies tests separately from source", () => {
    const s = survey(fixture());
    expect(s.hasTests).toBe(true);
    expect(s.modules.find((m) => m.path.endsWith("auth.test.ts"))?.kind).toBe("test");
  });

  it("reports existing commands so checks can be grounded in them", () => {
    const s = survey(fixture());
    expect(s.scripts.test).toBe("bun test");
    expect(Object.keys(s.scripts)).toContain("lint");
  });

  it("does not walk node_modules", () => {
    const s = survey(fixture());
    expect(s.modules.some((m) => m.path.includes("node_modules"))).toBe(false);
  });

  it("returns exists:false rather than throwing on a missing directory", () => {
    expect(survey(join(tmpdir(), "definitely-not-here-9f2a")).exists).toBe(false);
  });

  it("asks about files that exist rather than in the abstract", () => {
    const root = fixture();
    const asked = questionsFrom(survey(root)).join(" ");
    expect(asked).toContain("billing.ts");
    expect(asked).toContain("auth.ts");
  });

  it("asks how correctness is proven, grounded in what the repo already has", () => {
    const root = fixture();
    // The fixture has a test file, so the question should point at the existing
    // test command rather than asking for one from scratch.
    const asked = questionsFrom(survey(root)).join(" ");
    expect(asked).toContain("test");
    expect(asked).not.toContain("No tests");
  });

  it("gives an empty directory a starting question, not a file list", () => {
    const root = mkdtempSync(join(tmpdir(), "cubicore-empty-"));
    const asked = questionsFrom(survey(root)).join(" ");
    expect(asked).toContain("nothing here yet");
  });
});

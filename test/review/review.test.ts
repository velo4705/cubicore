import { describe, expect, test } from "bun:test";
import { anchorFor, movedAnchors, snapshotAnchors, type ReadFile } from "../../src/review/anchors";
import { gate, review, shouldReview, DEFAULT_TEST_GLOBS } from "../../src/review";
import type { Contract } from "../../src/contracts/types";

function manifest(scripts: Record<string, string>): string {
  return JSON.stringify({ name: "demo", scripts });
}

function reader(scripts: Record<string, string>): ReadFile {
  return (path) => (path === "package.json" ? manifest(scripts) : null);
}

const anchorReader = reader({
  lint: "eslint .",
  typecheck: "tsc --noEmit",
  test: "bun test",
});

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "w1",
    objective: "o",
    reads: [],
    writes: ["src/a.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: {},
    doneWhen: "d",
    checks: [],
    budget: { tokens: 20000, toolCalls: 40, wallMs: 300000 },
    ...overrides,
  };
}

describe("anchorFor", () => {
  test("resolves an npm script to its manifest entry", () => {
    const anchor = anchorFor("npm run lint", anchorReader);
    expect(anchor).toEqual({
      command: "npm run lint",
      file: "package.json",
      key: "scripts.lint",
      value: "eslint .",
    });
  });

  test("resolves pnpm, yarn and bun script runners", () => {
    for (const runner of ["pnpm run", "yarn run", "bun run"]) {
      expect(anchorFor(`${runner} test`, anchorReader)?.value).toBe("bun test");
    }
  });

  test("resolves the run-script long form", () => {
    expect(anchorFor("npm run-script lint", anchorReader)?.value).toBe("eslint .");
  });

  test("returns null for a bare command with no inspectable anchor", () => {
    // Not evidence of tampering, so it must not be guessed at.
    expect(anchorFor("tsc --noEmit", anchorReader)).toBeNull();
    expect(anchorFor("vitest run", anchorReader)).toBeNull();
  });

  test("returns null for a script the manifest does not define", () => {
    expect(anchorFor("npm run nonexistent", anchorReader)).toBeNull();
  });

  test("returns null when the manifest is missing", () => {
    expect(anchorFor("npm run lint", () => null)).toBeNull();
  });

  test("returns null when the manifest is unparseable", () => {
    expect(anchorFor("npm run lint", () => "{ not json")).toBeNull();
  });
});

describe("snapshotAnchors", () => {
  test("captures only the commands it can anchor", () => {
    const anchors = snapshotAnchors(["npm run lint", "tsc --noEmit"], anchorReader);
    expect([...anchors.keys()]).toEqual(["npm run lint"]);
  });

  test("captures nothing for an unanchored set", () => {
    expect(snapshotAnchors(["tsc", "eslint"], anchorReader).size).toBe(0);
  });
});

describe("movedAnchors", () => {
  test("reports an edited script", () => {
    const moved = movedAnchors(
      new Map([["npm run lint", "eslint ."]]),
      new Map([["npm run lint", "true"]]),
    );
    expect(moved).toHaveLength(1);
    expect(moved[0].after).toBe("true");
  });

  test("reports a removed script, which is how a check gets neutered", () => {
    const moved = movedAnchors(new Map([["npm run test", "bun test"]]), new Map());
    expect(moved).toHaveLength(1);
    expect(moved[0].after).toBe("(removed)");
  });

  test("reports nothing when nothing moved", () => {
    const same = new Map([["npm run lint", "eslint ."]]);
    expect(movedAnchors(same, new Map(same))).toHaveLength(0);
  });

  test("ignores a command that did not exist before the retry", () => {
    const moved = movedAnchors(new Map(), new Map([["npm run new", "x"]]));
    expect(moved).toHaveLength(0);
  });
});

describe("shouldReview", () => {
  test("does not review the first attempt", () => {
    expect(shouldReview(0)).toBe(false);
  });

  test("reviews the revise round, the only moment the bar can move", () => {
    expect(shouldReview(1)).toBe(true);
  });
});

describe("review", () => {
  const base = {
    contract: contract(),
    testFilesBefore: ["src/a.test.ts"],
    testFilesAfter: ["src/a.test.ts"],
  };

  test("finds nothing when the revision was clean", () => {
    const anchors = new Map([["npm run test", "bun test"]]);
    expect(review({ ...base, anchorsBefore: anchors, anchorsAfter: new Map(anchors) })).toEqual([]);
  });

  test("catches a worker that weakened a failing check", () => {
    const findings = review({
      ...base,
      anchorsBefore: new Map([["npm run test", "bun test"]]),
      anchorsAfter: new Map([["npm run test", "true"]]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("check-definition-moved");
    expect(findings[0].evidence).toContain("bun test");
    expect(findings[0].evidence).toContain("true");
  });

  test("catches removed tests, the green-by-deletion case", () => {
    const findings = review({
      ...base,
      anchorsBefore: new Map(),
      anchorsAfter: new Map(),
      testFilesBefore: ["src/a.test.ts", "src/b.test.ts"],
      testFilesAfter: ["src/a.test.ts"],
    });
    expect(findings[0].code).toBe("tests-removed");
    expect(findings[0].evidence).toContain("src/b.test.ts");
  });

  test("added tests are not a finding", () => {
    const findings = review({
      ...base,
      anchorsBefore: new Map(),
      anchorsAfter: new Map(),
      testFilesBefore: ["src/a.test.ts"],
      testFilesAfter: ["src/a.test.ts", "src/new.test.ts"],
    });
    expect(findings).toEqual([]);
  });

  test("attributes the finding to the contract under review", () => {
    const findings = review({
      ...base,
      contract: contract({ id: "w7" }),
      anchorsBefore: new Map([["npm run test", "bun test"]]),
      anchorsAfter: new Map([["npm run test", "true"]]),
    });
    expect(findings[0].contractId).toBe("w7");
  });

  test("reports both problems when both happened", () => {
    const findings = review({
      ...base,
      anchorsBefore: new Map([["npm run test", "bun test"]]),
      anchorsAfter: new Map([["npm run test", "true"]]),
      testFilesBefore: ["src/a.test.ts", "src/gone.test.ts"],
      testFilesAfter: ["src/a.test.ts"],
    });
    expect(findings.map((f) => f.code).sort()).toEqual([
      "check-definition-moved",
      "tests-removed",
    ]);
  });
});

describe("D5 novelty gate", () => {
  test("drops a finding with no evidence", () => {
    const dropped = gate([
      { code: "tests-removed", contractId: "w1", detail: "something felt off", evidence: "" },
    ]);
    expect(dropped).toEqual([]);
  });

  test("drops a whitespace-only finding", () => {
    expect(
      gate([{ code: "tests-removed", contractId: "w1", detail: "d", evidence: "   " }]),
    ).toEqual([]);
  });

  test("keeps a finding with evidence", () => {
    const finding = {
      code: "tests-removed" as const,
      contractId: "w1",
      detail: "d",
      evidence: "src/a.test.ts",
    };
    expect(gate([finding])).toEqual([finding]);
  });

  test("every finding the reviewer produces carries evidence by construction", () => {
    const findings = review({
      contract: contract(),
      anchorsBefore: new Map([["npm run test", "bun test"]]),
      anchorsAfter: new Map([["npm run test", "true"]]),
      testFilesBefore: ["a.test.ts"],
      testFilesAfter: [],
    });
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.evidence.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("test file globs", () => {
  test("covers the common conventions", () => {
    for (const pattern of ["**/*.test.*", "**/*.spec.*", "__tests__/**"]) {
      expect(DEFAULT_TEST_GLOBS).toContain(pattern);
    }
  });
});
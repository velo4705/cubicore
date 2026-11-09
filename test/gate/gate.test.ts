import { describe, expect, test } from "bun:test";
import { gateSchema, gateScope, gateStyle, gateVerify, matchesGlob, runGates, type CommandRunner } from "../../src/gate";
import type { Contract } from "../../src/contracts/types";

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "w1",
    objective: "o",
    reads: ["src/**"],
    writes: ["src/a.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: {},
    doneWhen: "d",
    checks: [
      { id: "unit", kind: "intent", command: "npm test -- a", expectation: "exit 0", gating: "blocking", convergent: true },
    ],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    ...overrides,
  };
}

const artifact = (raw: string, deliverable: Contract["deliverable"] = "diff") => ({
  contractId: "w1",
  deliverable,
  raw,
});

function runner(result: { exitCode: number; output?: string }): CommandRunner {
  return { async run() { return { exitCode: result.exitCode, output: result.output ?? "" }; } };
}

describe("matchesGlob", () => {
  test("* spans slashes, matching opencode resource semantics", () => {
    expect(matchesGlob("src/*", "src/a/b.ts")).toBe(true);
  });

  test("matches a literal exactly", () => {
    expect(matchesGlob("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/b.ts")).toBe(false);
  });

  test("does not treat regex metacharacters as regex", () => {
    expect(matchesGlob("src/a+b.ts", "src/a+b.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/aXts")).toBe(false);
  });
});

describe("gateSchema", () => {
  test("rejects an empty artifact as retryable", () => {
    const result = gateSchema({ artifact: artifact(""), contract: contract() });
    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(true);
  });

  test("accepts a diff as raw text", () => {
    expect(gateSchema({ artifact: artifact("+ added line"), contract: contract() }).passed).toBe(true);
  });

  test("rejects malformed JSON for a data deliverable", () => {
    const result = gateSchema({ artifact: artifact("{oops", "data"), contract: contract({ deliverable: "data" }) });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("not valid JSON");
  });

  test("accepts valid JSON for a data deliverable", () => {
    expect(gateSchema({ artifact: artifact('{"a":1}', "data"), contract: contract({ deliverable: "data" }) }).passed).toBe(true);
  });
});

describe("gateVerify", () => {
  test("passes when the blocking check succeeds", async () => {
    const result = await gateVerify({ artifact: artifact("x"), contract: contract() }, runner({ exitCode: 0 }));
    expect(result.passed).toBe(true);
  });

  test("fails retryably when a convergent blocking check exits non-zero", async () => {
    const result = await gateVerify({ artifact: artifact("x"), contract: contract() }, runner({ exitCode: 1, output: "FAIL" }));
    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(true);
  });

  test("does not gate on advisory checks", async () => {
    const c = contract({
      checks: [{ id: "cov", kind: "coverage", command: "cov", expectation: "e", gating: "advisory", convergent: true }],
    });
    const result = await gateVerify({ artifact: artifact("x"), contract: c }, runner({ exitCode: 1 }));
    expect(result.passed).toBe(true);
  });

  test("does not gate on non-convergent blocking checks", async () => {
    const c = contract({
      checks: [{ id: "cov", kind: "coverage", command: "cov", expectation: "e", gating: "blocking", convergent: false }],
    });
    const result = await gateVerify({ artifact: artifact("x"), contract: c }, runner({ exitCode: 1 }));
    expect(result.passed).toBe(true);
  });

  test("does not retry when the command cannot run at all", async () => {
    const throwing: CommandRunner = { async run() { throw new Error("ENOENT"); } };
    const result = await gateVerify({ artifact: artifact("x"), contract: contract() }, throwing);
    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(false);
  });

  test("includes baseline checks in the matrix", async () => {
    const commands: string[] = [];
    const spy: CommandRunner = {
      async run(command) { commands.push(command); return { exitCode: 0, output: "" }; },
    };
    await gateVerify(
      { artifact: artifact("x"), contract: contract(), baseline: [
        { id: "t", kind: "baseline", command: "npm run typecheck", expectation: "e", gating: "blocking", convergent: true },
      ] },
      spy,
    );
    expect(commands).toContain("npm run typecheck");
    expect(commands).toContain("npm test -- a");
  });
});

describe("gateScope", () => {
  test("passes when changed files are inside declared writes", () => {
    const result = gateScope({ artifact: artifact("x"), contract: contract() }, { changedFiles: ["src/a.ts"] });
    expect(result.passed).toBe(true);
  });

  test("fails without retry when a worker escapes its scope", () => {
    const result = gateScope({ artifact: artifact("x"), contract: contract() }, { changedFiles: ["src/b.ts"] });
    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.detail).toContain("src/b.ts");
  });

  test("a scope violation is never retryable, only reportable", () => {
    // Re-running would just reproduce the same out-of-scope write.
    const result = gateScope({ artifact: artifact("x"), contract: contract() }, { changedFiles: ["etc/passwd"] });
    expect(result.retryable).toBe(false);
  });

  test("honours a wide declared glob", () => {
    const c = contract({ writes: ["src/**"] });
    const result = gateScope({ artifact: artifact("x"), contract: c }, { changedFiles: ["src/deep/b.ts"] });
    expect(result.passed).toBe(true);
  });
});

describe("runGates", () => {
  test("stops at the schema gate", async () => {
    const gates = await runGates(
      { artifact: artifact("", "data"), contract: contract({ deliverable: "data" }) },
      runner({ exitCode: 0 }),
      { changedFiles: [] },
    );
    expect(gates).toHaveLength(1);
    expect(gates[0].gate).toBe("schema");
  });

  test("stops at verify without reaching scope", async () => {
    const gates = await runGates(
      { artifact: artifact("x"), contract: contract() },
      runner({ exitCode: 1 }),
      { changedFiles: ["src/b.ts"] },
    );
    expect(gates.map((g) => g.gate)).toEqual(["schema", "verify"]);
  });

  test("runs all three when both earlier gates pass", async () => {
    const gates = await runGates(
      { artifact: artifact("x"), contract: contract() },
      runner({ exitCode: 0 }),
      { changedFiles: ["src/b.ts"] },
    );
    expect(gates.map((g) => g.gate)).toEqual(["schema", "verify", "scope"]);
  });
});

describe("gateStyle", () => {
  const design = {
    direction: "editorial",
    palette: ["#0F0F0F", "#E6E6E6"],
    typeface: "Fraunces",
    notDoing: ["no second typeface"],
    ambition: "calm",
  };

  test("passes when no palette is declared", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cubicore-gate-style-"));
    fs.writeFileSync(path.join(dir, "x.css"), "body { color: #123456; }");
    const result = gateStyle({ artifact: { contractId: "w1", deliverable: "diff", raw: "x" }, contract: contract() }, { changedFiles: ["x.css"], root: dir });
    expect(result.passed).toBe(true);
  });

  test("fails on a raw hex outside the declared palette", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cubicore-gate-style-"));
    fs.writeFileSync(path.join(dir, "x.css"), "body { color: #123456; }");
    const result = gateStyle(
      { artifact: { contractId: "w1", deliverable: "diff", raw: "x" }, contract: contract() },
      { changedFiles: ["x.css"], root: dir, design },
    );
    expect(result.passed).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.detail).toContain("#123456");
  });

  test("accepts an in-palette hex (case-insensitive)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cubicore-gate-style-"));
    fs.writeFileSync(path.join(dir, "x.css"), "body { color: #0F0F0F; }");
    const result = gateStyle(
      { artifact: { contractId: "w1", deliverable: "diff", raw: "x" }, contract: contract() },
      { changedFiles: ["x.css"], root: dir, design },
    );
    expect(result.passed).toBe(true);
  });

  test("reports unverified when the change list cannot be read", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const result = gateStyle(
      { artifact: { contractId: "w1", deliverable: "diff", raw: "x" }, contract: contract() },
      { changedFiles: ["x.css"], root: path.join(os.tmpdir(), "cubicore-does-not-exist"), design },
    );
    expect(result.passed).toBe(false);
    expect(result.unverified).toBe(true);
  });

  test("accepts the contract when the palette is declared but the diff has no raw hex", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cubicore-gate-style-"));
    fs.writeFileSync(path.join(dir, "x.css"), "body { color: var(--fg); background: var(--bg); }");
    const result = gateStyle(
      { artifact: { contractId: "w1", deliverable: "diff", raw: "x" }, contract: contract() },
      { changedFiles: ["x.css"], root: dir, design },
    );
    expect(result.passed).toBe(true);
  });
});

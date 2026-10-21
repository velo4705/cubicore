import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gateScope } from "../src/gate";
import { changedFilesSince, isRepository, prepareRepository } from "../src/dispatch/changes";
import { parsePlan } from "../src/coordinator/parse";
import { tryIt } from "../src/plan/try";
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

  it("reports unknown when the directory is not a repository", async () => {
    const result = await changedFilesSince(repo());
    expect(result.unknown).toBe(true);
  });

  it("initialises a repository and makes a baseline", async () => {
    const root = repo();
    const result = await prepareRepository(root);
    expect(result.initialised).toBe(true);
    expect(result.committed).toBe(true);
    expect(await isRepository(root)).toBe(true);
  });

  it("never touches a repository that already exists", async () => {
    const root = repo();
    await prepareRepository(root);
    const before = await changedFilesSince(root);
    const second = await prepareRepository(root);
    expect(second.alreadyInitialised).toBe(true);
    expect(second.initialised).toBe(false);
    expect(second.committed).toBe(false);
    // And it did not stage or commit anything.
    expect((await changedFilesSince(root)).files).toEqual(before.files);
  });

  it("reports the files that changed after the baseline", async () => {
    const root = repo();
    const prepared = await prepareRepository(root);
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
    const changed = await changedFilesSince(root, prepared.baseline);
    expect(changed.unknown).toBe(false);
    expect(changed.files.join(" ")).toContain("src/b.ts");
  });
});

describe("the run block survives the whole round trip", () => {
  // It was broken twice: the parser rejected the key, and once it accepted
  // it, the value was read from nowhere and dropped. A plan's instructions on
  // how to run it would have vanished between the plan file and the dispatcher.
  it("parses the run block, including a zero-edge graph", () => {
    const parsed = parsePlan(
      JSON.stringify({
        topology: "fan-out",
        contracts: [
          {
            id: "a",
            objective: "Write a health endpoint that answers 200",
            reads: [],
            writes: ["src/health.ts"],
            forbidden: [],
            deliverable: "diff",
            schema: { type: "object" },
            doneWhen: "it answers",
            checks: [
              {
                id: "k",
                kind: "intent",
                command: "test -f src/health.ts",
                expectation: "e",
                gating: "blocking",
                convergent: true,
              },
            ],
            budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
          },
        ],
        graphBudget: { nodes: 1, edges: 0, tokens: 1000, wallMs: 1000 },
        try: {
          command: "node src/health.js",
          url: "http://127.0.0.1:3111/health",
          expect: { status: 200, bodyContains: "ok" },
        },
      }),
    );

    expect(parsed.try?.command).toBe("node src/health.js");
    expect(parsed.try?.url).toBe("http://127.0.0.1:3111/health");
    expect(parsed.try?.expect?.status).toBe(200);
    // A fan-out with no dependencies has zero edges, honestly.
    expect(parsed.graphBudget.edges).toBe(0);
  });

  it("runs what the plan said to run", async () => {
    const root = mkdtempSync(join(tmpdir(), "cubicore-try-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "health.js"),
      'require("node:http").createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});' +
        's.end(JSON.stringify({status:"ok"}))}).listen(3211);\n',
    );

    const outcome = await tryIt(
      { command: "node src/health.js", url: "http://127.0.0.1:3211/health", expect: { status: 200, bodyContains: "ok" } },
      root,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
  });
});

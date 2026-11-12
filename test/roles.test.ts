import { describe, expect, test } from "bun:test";
import { gateRole } from "../src/gate/index";
import { parsePlan } from "../src/coordinator/parse";
import type { Contract, Role } from "../src/contracts/types";

const VALID = {
  topology: "fan-out",
  contracts: [
    {
      id: "w", objective: "say hello", reads: [], writes: ["hello.txt"], forbidden: [],
      deliverable: "diff", schema: {}, doneWhen: "file exists",
      checks: [{ id: "c", kind: "intent", command: "true", expectation: "ok", gating: "blocking", convergent: true }],
      budget: { tokens: 1000, toolCalls: 10, wallMs: 60_000 },
    },
  ],
  graphBudget: { nodes: 1, edges: 0, tokens: 1000, wallMs: 1000 },
};

const role = (name: string): Role => ({
  name,
  capabilities: ["write:filesystem"],
  tools: { deny: ["webfetch", "websearch"] },
  handoff: { deliverable: "hello.txt on disk", audience: "integration" },
  escalation: "report blocked with reasons; do not retry",
});

describe("contract-role parser", () => {
  test("a plan with a fully populated role parses", () => {
    const c = { ...VALID.contracts[0], role: role("owner_of_types") };
    expect(() =>
      parsePlan(JSON.stringify({ ...VALID, contracts: [c] })),
    ).not.toThrow();
  });

  test("a role missing name is rejected", () => {
    const c = { ...VALID.contracts[0], role: { capabilities: ["write:filesystem"] } };
    expect(() => parsePlan(JSON.stringify({ ...VALID, contracts: [c] }))).toThrow();
  });

  test("an empty-name role is rejected", () => {
    const c = { ...VALID.contracts[0], role: { name: " ", capabilities: ["write:filesystem"] } };
    expect(() => parsePlan(JSON.stringify({ ...VALID, contracts: [c] }))).toThrow();
  });
});

describe("gateRole — honest advisory on this host", () => {
  const artifact = { contractId: "w", raw: "x", deliverable: "diff" } as unknown as import("../src/contracts/types").Artifact;
  const base = {
    ...VALID.contracts[0],
    role: undefined,
  } as unknown as Contract;

  test("no role declared — advisory simply says so", () => {
    const r = gateRole({ artifact, contract: base });
    expect(r.passed).toBe(true);
    expect(r.detail).toMatch(/no role declared/i);
  });

  test("role declared — advisory states the denies go to the agent config and names the host limitation", () => {
    const contract = {
      ...VALID.contracts[0],
      role: role("owner_of_ast"),
    } as unknown as Contract;
    const r = gateRole({ artifact, contract });
    expect(r.passed).toBe(true);
    expect(r.detail).toMatch(/webfetch/);
    expect(r.detail).toMatch(/agent config/i);
    expect(r.detail).toMatch(/attribution/i);
  });
});

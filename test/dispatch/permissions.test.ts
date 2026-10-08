import { describe, expect, test } from "bun:test";
import { workerPermissions, testerPermissions } from "../../src/dispatch/permissions";
import type { Contract } from "../../src/contracts/types";

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "w1",
    objective: "o",
    reads: ["src/**"],
    writes: ["src/a.ts"],
    forbidden: ["src/secret.ts"],
    deliverable: "diff",
    schema: {},
    doneWhen: "d",
    checks: [],
    budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    ...overrides,
  };
}

describe("workerPermissions", () => {
  test("denies all edits first so narrow allows can follow", () => {
    const rules = workerPermissions(contract());
    expect(rules[0]).toEqual({ action: "edit", resource: "*", effect: "deny" });
  });

  test("allows only the declared write globs", () => {
    const rules = workerPermissions(contract());
    const allows = rules.filter((r) => r.action === "edit" && r.effect === "allow");
    expect(allows).toEqual([{ action: "edit", resource: "src/a.ts", effect: "allow" }]);
  });

  test("re-deny comes after allow so forbidden wins the last match", () => {
    const rules = workerPermissions(contract());
    const allowIdx = rules.findIndex((r) => r.action === "edit" && r.effect === "allow");
    const denyIdx = rules.findIndex((r) => r.action === "edit" && r.resource === "src/secret.ts");
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  test("denies subagent spawning so a worker cannot bypass the plan", () => {
    const rules = workerPermissions(contract());
    expect(rules).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
  });

  test("uses no V1 action names", () => {
    const rules = workerPermissions(contract());
    const actions = rules.map((r) => r.action);
    expect(actions).not.toContain("bash");
    expect(actions).not.toContain("task");
  });

  test("a contract with a bare glob still gets a deny baseline", () => {
    const rules = workerPermissions(contract({ writes: ["**"] }));
    expect(rules[0].effect).toBe("deny");
    expect(rules.some((r) => r.effect === "allow" && r.resource === "**")).toBe(true);
  });
});

describe("testerPermissions", () => {
  test("denies all edits unconditionally", () => {
    const rules = testerPermissions(["src/**"]);
    const editAllows = rules.filter((r) => r.action === "edit" && r.effect === "allow");
    expect(editAllows).toHaveLength(0);
  });

  test("allows reads so it can still execute checks", () => {
    const rules = testerPermissions(["src/**"]);
    expect(rules).toContainEqual({ action: "read", resource: "src/**", effect: "allow" });
  });
});
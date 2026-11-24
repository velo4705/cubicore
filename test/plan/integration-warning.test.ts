import { describe, expect, test } from "bun:test";

import { integrationWarning } from "../../src/plan/integration-warning";
import type { Plan } from "../../src/contracts/types";

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  mode: "full",
  topology: "fan-out",
  contracts: [],
  graphBudget: { nodes: 1, edges: 0, tokens: 1000, wallMs: 1000 },
  ...overrides,
});

describe("integrationWarning", () => {
  test("warns on a full plan without an integration command", () => {
    expect(integrationWarning(plan())).toContain("no top-level `integration` command");
  });

  test("stays quiet when integration is declared", () => {
    expect(integrationWarning(plan({ integration: { command: "npm run build" } }))).toBe("");
  });

  test("stays quiet for demo plans", () => {
    expect(integrationWarning(plan({ mode: "demo" }))).toBe("");
  });
});

import { describe, expect, test } from "bun:test";
import { BudgetEnforcer, applyDenial } from "../../src/adapters/opencode/hooks";
import { deriveCaps } from "../../src/dispatch/budgets";
import type { Contract } from "../../src/contracts/types";

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
    budget: { tokens: 20000, toolCalls: 4, wallMs: 300000 },
    ...overrides,
  };
}

function enforcerWith(c = contract()): BudgetEnforcer {
  const enforcer = new BudgetEnforcer();
  enforcer.register("ses_1", c.id, deriveCaps(c));
  return enforcer;
}

describe("chat.params output cap", () => {
  test("sets maxOutputTokens from the contract's caps", () => {
    const output: { maxOutputTokens?: number } = {};
    enforcerWith().chatParams({ sessionID: "ses_1" }, output);
    expect(output.maxOutputTokens).toBe(deriveCaps(contract()).maxOutputTokens);
  });

  test("tightens an existing looser cap", () => {
    const output = { maxOutputTokens: 999_999 };
    enforcerWith().chatParams({ sessionID: "ses_1" }, output);
    expect(output.maxOutputTokens).toBeLessThan(999_999);
  });

  test("never loosens a cap the user already set lower", () => {
    const output = { maxOutputTokens: 500 };
    enforcerWith().chatParams({ sessionID: "ses_1" }, output);
    expect(output.maxOutputTokens).toBe(500);
  });

  test("ignores a session it does not manage", () => {
    const output: { maxOutputTokens?: number } = {};
    enforcerWith().chatParams({ sessionID: "ses_other" }, output);
    expect(output.maxOutputTokens).toBeUndefined();
  });

  test("is idempotent across repeated calls", () => {
    const enforcer = enforcerWith();
    const output: { maxOutputTokens?: number } = {};
    enforcer.chatParams({ sessionID: "ses_1" }, output);
    const first = output.maxOutputTokens;
    enforcer.chatParams({ sessionID: "ses_1" }, output);
    expect(output.maxOutputTokens).toBe(first);
  });
});

describe("tool-call cap", () => {
  test("allows calls up to the cap", () => {
    const enforcer = enforcerWith();
    for (let i = 0; i < 4; i++) {
      expect(enforcer.toolBefore({ sessionID: "ses_1", tool: "edit" }).allow).toBe(true);
    }
  });

  test("refuses the call past the cap", () => {
    const enforcer = enforcerWith();
    for (let i = 0; i < 4; i++) enforcer.toolBefore({ sessionID: "ses_1", tool: "edit" });
    const decision = enforcer.toolBefore({ sessionID: "ses_1", tool: "edit" });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("4");
  });

  test("keeps refusing once capped", () => {
    const enforcer = enforcerWith();
    for (let i = 0; i < 6; i++) enforcer.toolBefore({ sessionID: "ses_1", tool: "edit" });
    expect(enforcer.toolBefore({ sessionID: "ses_1", tool: "edit" }).allow).toBe(false);
  });

  test("records the overrun for the report", () => {
    const enforcer = enforcerWith();
    for (let i = 0; i < 5; i++) enforcer.toolBefore({ sessionID: "ses_1", tool: "edit" });
    const overruns = enforcer.overrunsFor();
    expect(overruns).toHaveLength(1);
    expect(overruns[0].kind).toBe("tool-calls");
    expect(overruns[0].contractId).toBe("w1");
    expect(overruns[0].limit).toBe(4);
  });

  test("does not count calls for another session", () => {
    const enforcer = enforcerWith();
    for (let i = 0; i < 4; i++) enforcer.toolBefore({ sessionID: "ses_other", tool: "edit" });
    expect(enforcer.toolBefore({ sessionID: "ses_1", tool: "edit" }).allow).toBe(true);
  });
});

describe("applyDenial", () => {
  test("writes a deny status when refusing", () => {
    const output: { args: unknown; status?: string } = { args: {} };
    applyDenial(output, { allow: false, reason: "capped" });
    expect(output.status).toBe("deny");
  });

  test("leaves the output untouched when allowing", () => {
    const output: { args: unknown; status?: string } = { args: {} };
    applyDenial(output, { allow: true });
    expect(output.status).toBeUndefined();
  });
});

describe("session lifecycle", () => {
  test("releases a session so a long-lived process does not accumulate caps", () => {
    const enforcer = enforcerWith();
    expect(enforcer.activeSessions()).toBe(1);
    enforcer.release("ses_1");
    expect(enforcer.activeSessions()).toBe(0);
  });

  test("a released session is no longer capped", () => {
    const enforcer = enforcerWith();
    for (let i = 0; i < 5; i++) enforcer.toolBefore({ sessionID: "ses_1", tool: "edit" });
    enforcer.release("ses_1");
    expect(enforcer.toolBefore({ sessionID: "ses_1", tool: "edit" }).allow).toBe(true);
  });

  test("records a wall-clock overrun", () => {
    const enforcer = enforcerWith();
    enforcer.recordWallClockOverrun("ses_1");
    expect(enforcer.wasStopped("ses_1")).toBe(true);
    expect(enforcer.overrunsFor()[0].kind).toBe("wall-clock");
  });

  test("does not report a stopped session that never overran", () => {
    expect(enforcerWith().wasStopped("ses_1")).toBe(false);
  });
});
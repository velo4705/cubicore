import { describe, expect, test } from "bun:test";
import {
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  OUTPUT_SHARE,
  BudgetLedger,
  admit,
  deriveCaps,
} from "../../src/dispatch/budgets";
import { coordinatorModel, routeModel, type ModelConfig } from "../../src/dispatch/routing";
import type { Check, Contract, GraphBudget } from "../../src/contracts/types";

function blocking(): Check {
  return { id: "u", kind: "intent", command: "npm test", expectation: "exit 0", gating: "blocking", convergent: true };
}

function advisory(): Check {
  return { id: "a", kind: "coverage", command: "vitest", expectation: "80%", gating: "advisory", convergent: true };
}

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
    checks: [blocking()],
    budget: { tokens: 20000, toolCalls: 40, wallMs: 300000 },
    ...overrides,
  };
}

const graph = (overrides: Partial<GraphBudget> = {}): GraphBudget => ({
  nodes: 8, edges: 16, tokens: 500000, wallMs: 1200000, ...overrides,
});

describe("deriveCaps", () => {
  test("gives output a share of the token budget", () => {
    expect(deriveCaps(contract({ budget: { tokens: 20000, toolCalls: 40, wallMs: 1 } })).maxOutputTokens)
      .toBe(Math.floor(20000 * OUTPUT_SHARE));
  });

  test("floors the output cap so a tiny budget can still emit a diff", () => {
    const caps = deriveCaps(contract({ budget: { tokens: 10, toolCalls: 1, wallMs: 1 } }));
    expect(caps.maxOutputTokens).toBe(MIN_OUTPUT_TOKENS);
  });

  test("caps the output ceiling so one worker cannot run away", () => {
    const caps = deriveCaps(contract({ budget: { tokens: 10_000_000, toolCalls: 1, wallMs: 1 } }));
    expect(caps.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
  });

  test("passes tool-call and wall caps through unchanged", () => {
    const caps = deriveCaps(contract());
    expect(caps.maxToolCalls).toBe(40);
    expect(caps.wallMs).toBe(300000);
  });
});

describe("BudgetLedger", () => {
  test("admits while there is room", () => {
    const ledger = new BudgetLedger(graph({ nodes: 2 }));
    expect(ledger.admit(contract({ id: "a" }))).toBe(true);
    expect(ledger.admit(contract({ id: "b" }))).toBe(true);
  });

  test("refuses once the node ceiling is reached", () => {
    const ledger = new BudgetLedger(graph({ nodes: 1 }));
    expect(ledger.admit(contract({ id: "a" }))).toBe(true);
    expect(ledger.admit(contract({ id: "b" }))).toBe(false);
  });

  test("refuses a contract that would blow the token ceiling", () => {
    // Ceiling funds the first contract's 10000 but not the second's.
    const small = contract({ id: "a", budget: { tokens: 10000, toolCalls: 40, wallMs: 300000 } });
    const ledger = new BudgetLedger(graph({ tokens: 15000 }));
    expect(ledger.admit(small)).toBe(true);
    expect(ledger.admit(small)).toBe(false);
  });

  test("never reserves more wall time than the graph allows", () => {
    const short = contract({ id: "a", budget: { tokens: 20000, toolCalls: 40, wallMs: 60000 } });
    const ledger = new BudgetLedger(graph({ wallMs: 100000 }));
    expect(ledger.admitWithWallTime(short)).toBe(true);
    expect(ledger.admitWithWallTime(short)).toBe(false);
  });

  test("does not consume budget for a refused contract", () => {
    const ledger = new BudgetLedger(graph({ nodes: 1 }));
    ledger.admit(contract({ id: "a" }));
    ledger.admit(contract({ id: "b" }));
    expect(ledger.snapshot().nodesUsed).toBe(1);
  });

  test("reports exhaustion once a ceiling is hit", () => {
    const ledger = new BudgetLedger(graph({ nodes: 1 }));
    expect(ledger.exhausted).toBe(false);
    ledger.admit(contract());
    expect(ledger.exhausted).toBe(true);
  });

  test("records observed spend as it happens", () => {
    const ledger = new BudgetLedger(graph({ tokens: 100000 }));
    ledger.record({ input: 900, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, 5000);
    expect(ledger.snapshot().tokensUsed).toBe(1000);
    expect(ledger.snapshot().wallMsUsed).toBe(5000);
  });

  test("never reports negative remaining budget", () => {
    const ledger = new BudgetLedger(graph({ tokens: 10 }));
    ledger.record({ input: 999, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, 0);
    expect(ledger.snapshot().remainingTokens).toBe(0);
  });
});

describe("admit", () => {
  test("splits a plan the budget can fund from the rest", () => {
    const { admitted, deferred } = admit(
      [contract({ id: "a" }), contract({ id: "b" }), contract({ id: "c" })],
      new BudgetLedger(graph({ nodes: 2 })),
    );
    expect(admitted.map((c) => c.id)).toEqual(["a", "b"]);
    expect(deferred.map((c) => c.id)).toEqual(["c"]);
  });

  test("defers every contract when the budget is spent", () => {
    const { admitted, deferred } = admit(
      [contract({ id: "a" })],
      new BudgetLedger(graph({ nodes: 0, tokens: 1, wallMs: 1 })),
    );
    expect(admitted).toHaveLength(0);
    expect(deferred).toHaveLength(1);
  });

  test("preserves plan order, because the planner encodes dependency", () => {
    const { admitted } = admit(
      [contract({ id: "z" }), contract({ id: "a" })],
      new BudgetLedger(graph({ nodes: 1 })),
    );
    expect(admitted.map((c) => c.id)).toEqual(["z"]);
  });
});

describe("routeModel", () => {
  const config: ModelConfig = { strong: "anthropic/opus", cheap: "anthropic/haiku" };

  test("uses the cheap model for a normal worker", () => {
    const decision = routeModel(contract(), config);
    expect(decision.model).toBe("anthropic/haiku");
    expect(decision.tier).toBe("cheap");
  });

  test("escalates to the strong model on the revise round", () => {
    expect(routeModel(contract(), config, { attempt: 1 }).model).toBe("anthropic/opus");
  });

  test("escalation outranks the advisory rule", () => {
    const decision = routeModel(contract({ checks: [advisory()] }), config, { attempt: 1 });
    expect(decision.tier).toBe("strong");
  });

  test("keeps advisory-only work cheap", () => {
    const decision = routeModel(contract({ checks: [advisory()] }), config);
    expect(decision.tier).toBe("cheap");
    expect(decision.reason).toContain("advisory");
  });

  test("a contract with only a non-convergent blocking check is still cheap", () => {
    const stuck: Check = { ...blocking(), convergent: false };
    expect(routeModel(contract({ checks: [stuck] }), config).tier).toBe("cheap");
  });

  test("the coordinator and aggregate get the strong model", () => {
    expect(coordinatorModel(config)).toBe("anthropic/opus");
  });

  test("every decision explains itself", () => {
    expect(routeModel(contract(), config).reason.length).toBeGreaterThan(0);
    expect(routeModel(contract(), config, { attempt: 1 }).reason.length).toBeGreaterThan(0);
  });
});

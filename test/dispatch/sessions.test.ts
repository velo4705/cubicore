import { describe, expect, test } from "bun:test";
import { WorkerSessions, type SessionSpawner } from "../../src/dispatch/spawn";
import { BudgetEnforcer } from "../../src/adapters/opencode/hooks";
import type { Contract } from "../../src/contracts/types";

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "w1",
    objective: "Add a parser",
    reads: ["src/config.ts"],
    writes: ["src/parser.ts"],
    forbidden: [],
    deliverable: "diff",
    schema: {},
    doneWhen: "tests pass",
    checks: [
      { id: "u", kind: "intent", command: "npm test", expectation: "exit 0", gating: "blocking", convergent: true },
    ],
    budget: { tokens: 20000, toolCalls: 40, wallMs: 300000 },
    ...overrides,
  };
}

/**
 * Builds a spawner that goes idle shortly after being prompted, so tests
 * exercise the real polling path rather than a fake that returns instantly.
 */
function autoIdleSpawner(sessionId = "ses_1", onPrompt?: () => void) {
  const calls: { agent?: string; text: string }[] = [];
  const sessionsRef: { current: WorkerSessions | null } = { current: null };

  const spawner: SessionSpawner = {
    async create() {
      return { sessionId };
    },
    async prompt(_session, input) {
      calls.push(input);
      onPrompt?.();
      setTimeout(
        () => sessionsRef.current?.onEvent({ type: "session.idle", properties: { sessionID: sessionId } }),
        25,
      );
    },
    async changedFiles() {
      return [];
    },
  };

  const sessions = new WorkerSessions(spawner);
  sessionsRef.current = sessions;
  return { sessions, spawner, calls };
}

describe("WorkerSessions", () => {
  test("accepts a run that reaches idle", async () => {
    const { sessions } = autoIdleSpawner();
    const result = await sessions.run(contract());
    expect(result.status).toBe("accepted");
    expect(result.contractId).toBe("w1");
  });

  test("marks a session error as failed rather than accepted", async () => {
    const { sessions } = autoIdleSpawner("ses_1", () => {
      setTimeout(
        () =>
          sessions.onEvent({
            type: "session.error",
            properties: { sessionID: "ses_1", error: { message: "provider timeout" } },
          }),
        5,
      );
    });
    expect((await sessions.run(contract())).status).toBe("failed");
  });

  test("marks an unfinished run as budget-exhausted", async () => {
    const { sessions, spawner } = autoIdleSpawner();
    // Never goes idle.
    spawner.prompt = async () => {};
    const result = await sessions.run(contract({ budget: { tokens: 100, toolCalls: 1, wallMs: 40 } }));
    expect(result.status).toBe("budget-exhausted");
  });

  test("exhaustion stays distinct from failure", async () => {
    const { sessions, spawner } = autoIdleSpawner();
    spawner.prompt = async () => {};
    const result = await sessions.run(contract({ budget: { tokens: 100, toolCalls: 1, wallMs: 40 } }));
    expect(result.status).not.toBe("failed");
    expect(result.usage.input).toBe(0);
  });

  test("collects changed files observed during the run", async () => {
    const { sessions } = autoIdleSpawner("ses_1", () => {
      setTimeout(
        () => sessions.onEvent({ type: "file.edited", properties: { sessionID: "ses_1", file: "src/parser.ts" } }),
        5,
      );
    });
    const result = await sessions.run(contract());
    expect(result.changedFiles).toContain("src/parser.ts");
  });

  test("falls back to the spawner's diff when no file events arrived", async () => {
    const sessions = new WorkerSessions({
      async create() { return { sessionId: "ses_1" }; },
      async prompt() {
        setTimeout(() => sessions.onEvent({ type: "session.idle", properties: { sessionID: "ses_1" } }), 25);
      },
      async changedFiles() { return ["src/from-diff.ts"]; },
    });
    expect((await sessions.run(contract())).changedFiles).toEqual(["src/from-diff.ts"]);
  });

  test("records observed usage", async () => {
    const { sessions } = autoIdleSpawner("ses_1", () => {
      setTimeout(
        () =>
          sessions.onEvent({
            type: "message.updated",
            properties: {
              info: { id: "m1", sessionID: "ses_1", role: "assistant", tokens: { input: 500, output: 40, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.05 },
            },
          }),
        5,
      );
    });
    const result = await sessions.run(contract());
    expect(result.usage.input).toBe(500);
    expect(result.usage.cost).toBeCloseTo(0.05);
  });

  test("does not accumulate observers between runs", async () => {
    const { sessions } = autoIdleSpawner();
    await sessions.run(contract({ id: "a" }));
    await sessions.run(contract({ id: "b" }));
    expect(sessions.inFlight).toBe(0);
  });

  test("releases its observer even when the spawner throws", async () => {
    const sessions = new WorkerSessions({
      async create() { return { sessionId: "ses_1" }; },
      async prompt() { throw new Error("session closed"); },
      async changedFiles() { return []; },
    });
    await expect(sessions.run(contract())).rejects.toThrow("session closed");
    expect(sessions.inFlight).toBe(0);
  });

  test("keeps sibling runs from contaminating each other", async () => {
    let counter = 0;
    const sessions = new WorkerSessions({
      async create() {
        counter++;
        return { sessionId: `ses_${counter}` };
      },
      // Keyed on the sessionId argument, not a shared counter: reading the
      // counter here would schedule both workers for the same session.
      async prompt(sessionId) {
        setTimeout(() => sessions.onEvent({ type: "session.idle", properties: { sessionID: sessionId } }), 20);
      },
      async changedFiles() { return []; },
    });

    const [a, b] = await Promise.all([
      sessions.run(contract({ id: "a" })),
      sessions.run(contract({ id: "b" })),
    ]);

    expect(a.status).toBe("accepted");
    expect(b.status).toBe("accepted");
    expect(a.contractId).toBe("a");
    expect(b.contractId).toBe("b");
  });

  test("exposes itself as a WorkerRunner", async () => {
    const { sessions } = autoIdleSpawner();
    expect((await sessions.asRunner().run(contract())).contractId).toBe("w1");
  });

  test("sends the rendered contract without inventing an agent name", async () => {
    const { sessions, calls } = autoIdleSpawner();
    await sessions.run(contract());
    expect(calls).toHaveLength(1);
    // An agent the host does not know is accepted and silently ignored, so a
    // made-up name costs a dispatch and buys nothing. See spawn.ts.
    expect(calls[0].agent).toBeUndefined();
    expect(calls[0].text).toContain("# Objective");
    expect(calls[0].text).toContain("src/parser.ts");
  });
});
describe("WorkerSessions budget enforcement", () => {
  test("registers caps on creation and releases them on completion", async () => {
    const enforcer = new BudgetEnforcer();
    let peak = 0;

    const wired = new WorkerSessions(
      {
        async create() {
          return { sessionId: "ses_1" };
        },
        // Sampled here, not in create(): caps are registered after the session
        // exists, so create() would observe zero.
        async prompt() {
          peak = Math.max(peak, enforcer.activeSessions());
          setTimeout(() => wired.onEvent({ type: "session.idle", properties: { sessionID: "ses_1" } }), 25);
        },
        async changedFiles() { return []; },
      },
      undefined,
      enforcer,
    );

    await wired.run(contract());

    // Registered while the worker was alive, released once it finished.
    expect(peak).toBe(1);
    expect(enforcer.activeSessions()).toBe(0);
  });

  test("asks the host to cancel when the wall budget is blown", async () => {
    const cancelled: string[] = [];
    const sessions = new WorkerSessions(
      { async create() { return { sessionId: "ses_1" }; },
        async prompt() {},
        async changedFiles() { return []; },
        async cancel(id) { cancelled.push(id); } },
    );
    const result = await sessions.run(contract({ budget: { tokens: 100, toolCalls: 1, wallMs: 40 } }));
    expect(result.status).toBe("budget-exhausted");
    expect(result.cancelled).toBe(true);
    expect(cancelled).toEqual(["ses_1"]);
  });

  test("reports cancelled=false when the host cannot cancel", async () => {
    const sessions = new WorkerSessions({
      async create() { return { sessionId: "ses_1" }; },
      async prompt() {},
      async changedFiles() { return []; },
    });
    const result = await sessions.run(contract({ budget: { tokens: 100, toolCalls: 1, wallMs: 40 } }));
    expect(result.status).toBe("budget-exhausted");
    // Honest: Cubicore stopped waiting, but the session may still be spending.
    expect(result.cancelled).toBe(false);
  });

  test("a clean run is never marked cancelled", async () => {
    const { sessions } = autoIdleSpawner();
    expect((await sessions.run(contract())).cancelled).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { readSession, SqliteTokenSource, defaultDbPath, type TokenDb } from "../../src/bench/tokens";

function fakeDb(over: Partial<TokenDb> = {}): TokenDb {
  return {
    sessionRow: () => null,
    messageData: () => [],
    ...over,
  };
}

describe("readSession — denormalised columns", () => {
  const row = {
    id: "ses_1",
    cost: 0.25,
    tokens_input: 1200,
    tokens_output: 340,
    tokens_reasoning: 90,
    tokens_cache_read: 8192,
    tokens_cache_write: 512,
    time_created: 1_000,
    time_updated: 6_000,
  };

  test("reads usage straight off the session row", () => {
    const read = readSession(fakeDb({ sessionRow: () => row }), "ses_1");
    expect(read.usage).toEqual({
      input: 1200, output: 340, reasoning: 90, cacheRead: 8192, cacheWrite: 512, cost: 0.25,
    });
    expect(read.found).toBe(true);
  });

  test("derives duration from the session timestamps", () => {
    expect(readSession(fakeDb({ sessionRow: () => row }), "ses_1").durationMs).toBe(5000);
  });

  test("returns no duration when the timestamps are unusable", () => {
    const bad = { ...row, time_updated: 0 };
    expect(readSession(fakeDb({ sessionRow: () => bad }), "ses_1").durationMs).toBeNull();
  });

  test("reports a missing session rather than throwing", () => {
    const read = readSession(fakeDb(), "ses_missing");
    expect(read.found).toBe(false);
    expect(read.usage.input).toBe(0);
  });
});

describe("readSession — message fallback", () => {
  test("aggregates assistant messages when the columns are absent", () => {
    const messages = [
      { id: "m1", role: "assistant", tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } }, cost: 0.01 },
      { id: "m2", role: "assistant", tokens: { input: 20, output: 7, cache: { read: 0, write: 0 } }, cost: 0.02 },
    ];
    const read = readSession(fakeDb({ messageData: () => messages }), "ses_1");
    expect(read.usage.input).toBe(30);
    expect(read.usage.cost).toBeCloseTo(0.03);
    expect(read.found).toBe(true);
  });

  test("deduplicates repeated message ids, which streaming produces", () => {
    const duplicate = { id: "m1", role: "assistant", tokens: { input: 10, cache: {} } };
    const read = readSession(fakeDb({ messageData: () => [duplicate, duplicate] }), "ses_1");
    expect(read.usage.input).toBe(10);
  });

  test("parses a stored JSON string", () => {
    const stored = JSON.stringify({ id: "m1", role: "assistant", tokens: { input: 42 } });
    expect(readSession(fakeDb({ messageData: () => [stored] }), "ses_1").usage.input).toBe(42);
  });

  test("skips malformed entries instead of failing the whole read", () => {
    const messages = ["{ broken", null, { id: "m1", role: "assistant", tokens: { input: 7 } }];
    expect(readSession(fakeDb({ messageData: () => messages }), "ses_1").usage.input).toBe(7);
  });

  test("ignores user messages", () => {
    const messages = [{ id: "u1", role: "user", tokens: { input: 999 } }];
    expect(readSession(fakeDb({ messageData: () => messages }), "ses_1").found).toBe(false);
  });

  test("a row without token columns falls through to the message path", () => {
    const row = { id: "ses_1", time_created: 1, time_updated: 2 };
    const messages = [{ id: "m1", role: "assistant", tokens: { input: 11 } }];
    const read = readSession(fakeDb({ sessionRow: () => row, messageData: () => messages }), "ses_1");
    expect(read.usage.input).toBe(11);
  });
});

describe("db path discovery", () => {
  test("honours an explicit override", () => {
    const original = process.env.CUBICORE_OPENCODE_DB;
    process.env.CUBICORE_OPENCODE_DB = "/tmp/custom.db";
    try {
      expect(defaultDbPath()).toBe("/tmp/custom.db");
    } finally {
      if (original === undefined) delete process.env.CUBICORE_OPENCODE_DB;
      else process.env.CUBICORE_OPENCODE_DB = original;
    }
  });

  test("falls back to opencode's documented location", () => {
    const original = process.env.CUBICORE_OPENCODE_DB;
    delete process.env.CUBICORE_OPENCODE_DB;
    try {
      expect(defaultDbPath()).toContain("opencode");
    } finally {
      if (original !== undefined) process.env.CUBICORE_OPENCODE_DB = original;
    }
  });
});

describe("SqliteTokenSource against the real database", () => {
  const source = new SqliteTokenSource();

  test("returns zero usage for a session that does not exist", () => {
    const read = source.readSession("ses_does_not_exist");
    expect(read.found).toBe(false);
    expect(read.usage.input).toBe(0);
  });
});
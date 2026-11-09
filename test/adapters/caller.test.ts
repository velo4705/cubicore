import { describe, expect, test } from "bun:test";
import { pickCallerSession, type ListedCallerSession } from "../../src/adapters/opencode/caller";

const s = (over: Partial<ListedCallerSession>): ListedCallerSession => ({
  id: "ses_x",
  title: "untitled",
  outcome: "succeeded",
  cost: 1,
  tokens: { input: 1000, output: 10 },
  time: { created: 1, updated: 2 },
  ...over,
});

describe("pickCallerSession — the founder beats the zombies", () => {
  test("a failed empty probe loses to a healthy session", () => {
    const picked = pickCallerSession([
      s({ id: "ses_dead", outcome: "failed", cost: 0, tokens: { input: 0, output: 0 }, time: { created: 9999, updated: 9999 }, title: "bench-probe" }),
      s({ id: "ses_founder", time: { created: 100, updated: 200 } }),
    ]);
    expect(picked).toBe("ses_founder");
  });

  test("cubicore's own associate sessions never win over the founder's session", () => {
    const picked = pickCallerSession([
      s({ id: "ses_marker", title: "marker-b (associate)", time: { created: 9999, updated: 10000 } }),
      s({ id: "ses_founder", time: { created: 100, updated: 200 } }),
    ]);
    expect(picked).toBe("ses_founder");
  });

  test("an associate may win only when nothing healthier exists", () => {
    const picked = pickCallerSession([
      s({ id: "ses_marker", title: "marker-b (associate)", time: { created: 9999, updated: 10000 } }),
    ]);
    expect(picked).toBe("ses_marker");
  });

  test("a healthy founder session still beats a newer hollow one", () => {
    const picked = pickCallerSession([
      s({ id: "ses_hollow", outcome: "succeeded", cost: 0, tokens: { input: 0, output: 0 }, time: { created: 9999, updated: 9999 } }),
      s({ id: "ses_founder", time: { created: 100, updated: 200 } }),
    ]);
    expect(picked).toBe("ses_founder");
  });

  test("invalidate empty lists honestly", () => {
    expect(pickCallerSession([])).toBeUndefined();
  });
});

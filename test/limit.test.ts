import { describe, expect, it } from "bun:test";

/**
 * A limit that only staggers the starts is not a limit. Every task is still
 * running once the last one starts, and twelve simultaneous model sessions
 * took the machine to load 70 -- which measures the saturation rather than
 * the work.
 */

/** The same limiter the benchmark uses, kept here so it is exercised. */
function pLimit(size: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= size) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

describe("concurrency limit", () => {
  it("never runs more than the limit at once", async () => {
    const limit = pLimit(3);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 12 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(25);
          active--;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("runs everything, and a failure does not wedge the queue", async () => {
    const limit = pLimit(2);
    const done: number[] = [];

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        limit(async () => {
          if (i === 1) throw new Error("boom");
          done.push(i);
          await Bun.sleep(5);
        }).catch(() => {}),
      ),
    );

    expect(done.sort()).toEqual([0, 2, 3, 4, 5]);
  });
});

import { describe, expect, test } from "bun:test";
import { __testing, type ScreenshotMetrics } from "../../src/screenshot/check";

const flat: ScreenshotMetrics = { saturation: 0.02, uniformBlock: 0.80, lumaStdDev: 4, consoleErrors: 0 };
const ok: ScreenshotMetrics = { saturation: 0.30, uniformBlock: 0.50, lumaStdDev: 22, consoleErrors: 0 };
const good: ScreenshotMetrics = { saturation: 0.50, uniformBlock: 0.30, lumaStdDev: 40, consoleErrors: 0 };

describe("verdictFor — the visual credibility bar", () => {
  test("a flat image is flagged flat — not good", () => {
    expect(__testing.verdictFor(flat)).toBe("flat");
  });

  test("mid-saturation, mid-uniformity lands at ok", () => {
    expect(__testing.verdictFor(ok)).toBe("ok");
  });

  test("high saturation + varied pixels is good", () => {
    expect(__testing.verdictFor(good)).toBe("good");
  });

  test("uniform > 75% AND saturation < 18% collapses to flat regardless of other signals", () => {
    expect(
      __testing.verdictFor({ saturation: 0.10, uniformBlock: 0.80, lumaStdDev: 12, consoleErrors: 0 }),
    ).toBe("flat");
    expect(
      __testing.verdictFor({ saturation: 0.05, uniformBlock: 0.90, lumaStdDev: 1, consoleErrors: 0 }),
    ).toBe("flat");
  });

  test("uniform <= 55% AND saturation >= 40% is good", () => {
    expect(
      __testing.verdictFor({ saturation: 0.40, uniformBlock: 0.55, lumaStdDev: 30, consoleErrors: 0 }),
    ).toBe("good");
  });

  test("saturation alone does not save a low-viber image", () => {
    expect(
      __testing.verdictFor({ saturation: 0.45, uniformBlock: 0.70, lumaStdDev: 20, consoleErrors: 0 }),
    ).not.toBe("good");
  });
});

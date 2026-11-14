import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateVariants, recordVariantPick } from "../../src/plan/variants";
import { parsePlan } from "../../src/coordinator/parse";
import type { Plan } from "../../src/contracts/types";

const PLAN = {
  topology: "fan-out",
  summary: "Pine: a tiny open-air gardening companion app. Grow the tomato aisle first.",
  opinion: "What the founder wants is small real things kept honest by care.",
  contracts: [
    {
      id: "foundation",
      objective: "Scaffold the project with vite and TypeScript",
      reads: [],
      writes: ["package.json"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "npm run build exits 0",
      checks: [],
      budget: { tokens: 1000, toolCalls: 10, wallMs: 60_000 },
    },
  ],
  graphBudget: { nodes: 1, edges: 0, tokens: 1000, wallMs: 60_000 },
  design: {
    direction: "hand-drawn warmth",
    palette: ["#f4ead8", "#1f2a1f", "#2f7d3a", "#c7742c"],
    typeface: "Fraunces",
    notDoing: ["no dark mode", "no second typeface"],
    ambition: "calm",
  },
} as const;

const withReference = { ...PLAN, reference: "https://example.com/pine" } as unknown as Plan;

describe("variants — founder sees directions, not genre means", () => {
  test("a plan with no design is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-variants-"));
    const out = generateVariants({ ...PLAN, design: undefined } as unknown as Plan, dir);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/design/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a plan with no reference is refused — variants would default to the genre mean", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-variants-"));
    const out = generateVariants(PLAN as unknown as Plan, dir);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/reference/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("all three variants render and every hex in the output is on the palette", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-variants-"));
    const out = generateVariants(withReference, dir);
    expect(out.ok).toBe(true);
    expect(out.paths).toHaveLength(3);
    const palette = new Set(withReference.design!.palette.map((h) => h.toLowerCase()));
    for (const { path } of out.paths) {
      const html = readFileSync(path, "utf8");
      const hexes = [...html.matchAll(/#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}\b/g)].map((m) => m[0].toLowerCase());
      for (const hex of hexes) {
        expect(palette.has(hex)).toBe(true);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("a pick is recorded in the lifecycle and the variants dir holds evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-variants-"));
    generateVariants(withReference, dir);
    const pick = recordVariantPick(dir, "b", "fuschia haze wins");
    expect(pick.ok).toBe(true);
    const second = recordVariantPick(dir, "z");
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/a, b, c/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("picking an unrendered variant is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-variants-"));
    const pick = recordVariantPick(dir, "a");
    expect(pick.ok).toBe(false);
    expect(pick.message).toMatch(/not been rendered/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("parsePlan round-trips reference into the artifacts list", () => {
    const raw = JSON.stringify(withReference);
    expect(parsePlan(raw).reference).toBe("https://example.com/pine");
  });
});

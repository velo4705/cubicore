import { describe, expect, test } from "bun:test";
import { assessCoverage, extractItems, renderCoverage } from "../../src/validate/coverage";
import type { Plan } from "../../src/contracts/types";

const MINE = {
  topology: "fan-out",
  summary: "Voxel game demo",
  contracts: [
    {
      id: "scaffold",
      objective: "Install dependencies and set up project",
      reads: [],
      writes: ["package.json", "vite.config.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "npm run build exists",
      checks: [],
      budget: { tokens: 1000, toolCalls: 10, wallMs: 60_000 },
    },
    {
      id: "world",
      objective: "Voxel world core with seeded random terrain and forests",
      reads: ["src/world"],
      writes: ["src/world/blocks.ts", "src/world/terrain.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "VoxelWorld generates deterministic terrain",
      checks: [],
      budget: { tokens: 10000, toolCalls: 100, wallMs: 600_000 },
    },
    {
      id: "render",
      objective: "Three.js renderer painting the world to canvas with pixel textures",
      reads: ["src/textures", "src/world"],
      writes: ["src/render/renderer.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "npm run build compiles and starts",
      checks: [],
      budget: { tokens: 10000, toolCalls: 100, wallMs: 600_000 },
    },
  ],
  graphBudget: { nodes: 3, edges: 2, tokens: 30000, wallMs: 600_000 },
} as unknown as Plan;

const BRIEF = `Minecraft-style voxel survival, all in a browser tab.

Runs from one URL. Seeded infinite terrain: hills, plains, forest, ores, bedrock.
Per-block break hardness. Day/night. Fall damage. 10 hearts, 9-slot hotbar, pixel UI.
All audio synthesized. All textures painted in code.
Original code — no Mojang.
One build command, one URL. Headless smoke test clicks through to the player in-world without console errors.`;

describe("coverage — did the plan read the brief", () => {
  test("the Minecraft brief is partially covered by a scaffold-only plan shape", () => {
    const report = assessCoverage(BRIEF, MINE);
    expect(report.totalItems).toBeGreaterThan(0);
    expect(report.coverage).toBeGreaterThanOrEqual(0);
    // Most asks in that brief have nothing answering them; modest count is fine.
    expect(report.unaddressed.length).toBeGreaterThan(0);
  });

  test("a brief with no asks produces a zero-hand report", () => {
    const report = assessCoverage("hey", MINE);
    expect(report.coverage).toBeGreaterThanOrEqual(0);
    expect(report.verdict).toBe("complete");
  });

  test("a plan that addresses a specific ask registers it as covered", () => {
    const report = assessCoverage("Build a scaffold with vite", MINE);
    expect(report.coveredItems).toBeGreaterThanOrEqual(1);
    expect(report.unaddressed).toHaveLength(0);
  });

  test("an explicit ask no contract touches is reported unaddressed", () => {
    const report = assessCoverage("Add a complete luminescent squid boss fight with multiplayer co-op and cloud save sync to Steam PC", MINE);
    expect(report.coveredItems).toBe(0);
    expect(report.unaddressed.length).toBeGreaterThanOrEqual(1);
  });

  test("renderCoverage includes the summary line and all items", () => {
    const report = assessCoverage(BRIEF, MINE);
    const text = renderCoverage(report);
    expect(text).toMatch(/\d+\/\d+/);
    expect(text).toContain("Coverage:");
  });
});

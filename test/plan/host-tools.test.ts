import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHostToolsAt } from "../../src/plan/host-tools";
import { toolHints, renderToolHint } from "../../src/plan/tool-hint";
import { parsePlan } from "../../src/coordinator/parse";

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cubicore-hosttools-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function plan(summary: string, tools = [""]): ReturnType<typeof parsePlan> {
  return parsePlan(
    JSON.stringify({
      topology: "fan-out",
      summary,
      contracts: [
        {
          id: "w1",
          objective: "Build the thing",
          reads: [],
          writes: ["src/x.ts"],
          forbidden: [],
          deliverable: "diff",
          schema: {},
          doneWhen: "npm run build exits 0",
          checks: [],
          budget: { tokens: 10, toolCalls: 3, wallMs: 1000 },
          ...(tools.length && tools[0] ? { tools } : {}),
        },
      ],
      graphBudget: { nodes: 1, edges: 0, tokens: 10, wallMs: 1000 },
    }),
  );
}

describe("host tools — read what this host declares, never guess", () => {
  test("reads a config with both mcp and servers blocks", () => {
    const dir = fixture({
      "opencode.json": JSON.stringify({
        mcp: { gsd: { type: "local", command: ["npx", "-y", "@opengsd/gsd-core", "gsd-mcp-server"] } },
        servers: { playwright: { type: "local", command: ["npx", "-y", "@playwright/mcp@latest"] } },
      }),
    });
    const tools = readHostToolsAt(join(dir, "opencode.json"));
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["gsd", "playwright"]);
    expect(tools.find((t) => t.name === "playwright")?.commandOrUrl).toContain("playwright");
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns an empty array when nothing is declared — never throws", () => {
    expect(readHostToolsAt("/nonexistent/path/opencode.json")).toEqual([]);
  });

  test("a declared MCP matches when the brief names the tool", () => {
    const dir = fixture({
      "opencode.json": JSON.stringify({
        mcp: { "godot-mcp": { type: "local", command: ["npx", "-y", "@coding-solo/godot-mcp", "start-godot-mcp"] } },
      }),
    });
    const p = plan("Build Minecraft in Godot.");
    const notice = toolHints(p, join(dir, "opencode.json"));
    expect(notice.map((n) => n.tool)).toContain("godot");
    expect(notice.find((n) => n.tool === "godot")?.installedServer).toBe("godot-mcp");
    expect(notice.find((n) => n.tool === "godot")?.suggestion).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an undeclared well-known tool is reported missing with a suggestion", () => {
    const dir = fixture({ "opencode.json": JSON.stringify({ mcp: {} }) });
    const p = plan("Build a FreeCAD bracket.");
    const notice = toolHints(p, join(dir, "opencode.json"));
    expect(notice.map((n) => n.tool)).toContain("freecad");
    expect(notice.find((n) => n.tool === "freecad")?.installedServer).toBeNull();
    expect(notice.find((n) => n.tool === "freecad")?.suggestion).toContain("sandraschi");
    rmSync(dir, { recursive: true, force: true });
  });

  test("founder sees ✓/✗ inline — the rendered block carries both states", () => {
    const dir = fixture({
      "opencode.json": JSON.stringify({
        mcp: { "godot-mcp": { type: "local", command: ["npx", "-y", "@coding-solo/godot-mcp"] } },
      }),
    });
    const p = plan("Build Minecraft in Godot, then export to FreeCAD.");
    const text = renderToolHint(toolHints(p, join(dir, "opencode.json"))).join("\n");
    expect(text).toContain("godot — ✓ godot-mcp (installed)");
    expect(text).toContain("freecad — ✗ no MCP installed");
    expect(text).toContain("install:");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a plan naming nothing exotic produces no hints", () => {
    const dir = fixture({ "opencode.json": JSON.stringify({ mcp: {} }) });
    const p = plan("Add a parser for the config file.");
    expect(toolHints(p, join(dir, "opencode.json"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

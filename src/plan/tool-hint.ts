/**
 * Tool hints — briefs that name an external tool must either declare it,
 * or hear about it. The lesson from 2026-11: never forget that the host
 * already knows what it has installed, and the agent should too.
 *
 * Principle enforced by the planner prompt:
 *   "If the user mentions any external tool, use the tool that exists in his
 *    MCP list. Otherwise, report the issue and suggest."
 *
 * THIS is not a frozen catalog. It reads what this host actually declares,
 * so the hint always matches reality, never a wishlist. The known-tool list
 * at the bottom is for the *suggest* case only — the words typed in the plan
 * never bind it; an installed `foo-mcp` is folded in automatically.
 */

import { hostsMatching, readHostTools, readHostToolsAt, type HostTool } from "./host-tools";
import type { Plan } from "../contracts/types";

export interface ToolHintNotice {
  /** The tool mapped to a host MCP (or missing from it). */
  tool: string;
  /** Installed MCP server id, or null when absent. */
  installedServer: string | null;
  /** Best-effort install line for the founder. */
  suggestion: string | null;
}

/**
 * Known install suggestions for tools the founder might plausibly name.
 * HINT LIST — not a wishlist. Missing MCP ids go to `suggestion: null`;
 * the founder is told plainly that nothing is installed and Cubicore will
 * not carry the claim.
 */
const KNOWN_INSTALL: Record<string, string> = {
  godot: "npx -y @coding-solo/godot-mcp",
  unity: "Unity Editor (6000.x+, built-in assistant package — `Unity > Add MCP`) or CoplayDev/unity-mcp",
  unreal: "Unreal Engine 5.8+ (built-in `Engine Preferences > MCP`) or remiphilippe/mcp-unreal",
  blender: "blender.org MCP server (Blender 5.x) — see https://www.blender.org/lab/mcp-server/",
  arduino: "npx -y arduino-mcp-server",
  freecad: "sandraschi/freecad-mcp (GitHub)",
  fusion360: "In-app MCP available in Fusion 360 >= May 2026 (Preferences > General > API)",
  gimp: "gimp-mcp — start its MCP server inside GIMP (Tools > MCP > Start)",
  imagemagick: "ImageMagick (system) — no MCP required; command-line only",
  photoshop: "No official Photoshop MCP. community photoshop MCP candidates exist — verify before installing.",
  figma: "Figma Dev Mode MCP — enable it under Preferences in Figma desktop",
};

interface ToolHit {
  /** Tool name that was mentioned. */
  tool: string;
  /** Installed MCP server id, or null. */
  server: string | null;
}

/** Collect distinct mentioned tool names across the plan text. */
function mentioned(plan: Plan, installed: readonly HostTool[]): ToolHit[] {
  const parts: string[] = [];
  if (plan.summary) parts.push(plan.summary);
  if (plan.opinion) parts.push(plan.opinion);
  if (plan.context?.problem) parts.push(plan.context.problem);
  if (plan.context?.ask) for (const a of plan.context.ask) parts.push(a);
  for (const contract of plan.contracts) {
    parts.push(contract.objective ?? "");
    parts.push(contract.doneWhen ?? "");
    if (contract.steps) for (const step of contract.steps) parts.push(step.description);
  }
  const text = parts.join(" ").toLowerCase();
  const hits = new Map<string, ToolHit>();
  // 1) Host-declared servers whose baseName appears in the text — trust these.
  for (const t of hostsMatching(installed, text)) {
    hits.set(t.baseName, { tool: t.baseName, server: t.name });
  }
  // 2) Well-known tool names in the text — suggestion list, regardless of install state.
  for (const name of Object.keys(KNOWN_INSTALL)) {
    if (text.includes(name.toLowerCase())) {
      const installedServer = installed.find((t) => t.baseName === name)?.name ?? null;
      hits.set(name, { tool: name, server: installedServer });
    }
  }
  return [...hits.values()];
}

export function toolHints(plan: Plan, configPath?: string): ToolHintNotice[] {
  const installed = configPath ? readHostToolsAt(configPath) : readHostTools();
  const hits = mentioned(plan, installed);
  return hits
    // a hit is "blocking UX" only when a tool is named but nothing is installed;
    // an installed server is enough — exact working is the gate's job, not the hint's.
    .map((hit) => ({
      tool: hit.tool,
      installedServer: hit.server,
      suggestion: hit.server ? null : (KNOWN_INSTALL[hit.tool] ?? null),
    }));
}

/** Founder-facing — never refuses; always tells them the truth. */
export function renderToolHint(hints: readonly ToolHintNotice[]): string[] {
  if (hints.length === 0) return [];
  const lines = [
    "**Tool check (founder-visible):** the plan names these external tools:",
  ];
  const missing = hints.filter((h) => !h.installedServer);
  for (const h of hints) {
    const ok = h.installedServer ? `✓ ${h.installedServer} (installed)` : "✗ no MCP installed";
    lines.push(`- ${h.tool} — ${ok}`);
    if (h.suggestion) {
      lines.push(`  install: ${h.suggestion}`);
    } else if (!h.installedServer) {
      lines.push("  (no known install line for this tool — ask the founder or skip it)");
    }
  }
  if (missing.length > 0) {
    lines.push(
      `${missing.length} tool(s) not installed. Associates denied by default cannot use them until you install one and either plan declares it or you accept the gap.`,
    );
  }
  return lines;
}

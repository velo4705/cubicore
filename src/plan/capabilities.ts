/**
 * What the host can do that Cubicore cannot.
 *
 * The Main agent's tool list already contains every MCP server's tools. What
 * it does not have is any indication that they exist, or that one of them
 * would do the job better than a shell loop. So "research how to analyse
 * this binary" becomes `curl`, `strings`, and twenty minutes.
 *
 * The host's inventory is a single endpoint, and it names the servers and
 * whether they are connected. That is enough for a model to choose: it
 * already has the tools, and now it knows the tools are worth reaching for.
 */

export interface Capability {
  server: string;
  connected: boolean;
  /** What the server is for, where it is well known. */
  purpose?: string;
}

/** What the common servers are for. Advisory -- the model knows better. */
const PURPOSES: Record<string, string> = {
  rea: "native binaries, protocols, reverse engineering",
  playwright: "browsers and web interaction",
  context7: "library documentation and API reference",
  github: "issues, pull requests, code search",
  "hf-mcp-server": "models and datasets",
  gsd: "project planning and execution",
  "magicuidesign-mcp": "UI components and design",
  "openai-docs": "OpenAI documentation",
  exa: "web search and page content",
  "sequential-thinking": "structured reasoning",
  filesystem: "file operations",
};

export async function capabilities(
  baseUrl: string,
  auth?: string,
): Promise<Capability[]> {
  try {
    const response = await fetch(`${baseUrl}/mcp`, {
      headers: auth ? { Authorization: auth } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];

    const servers = (await response.json()) as Record<string, { status?: string }>;
    return Object.entries(servers).map(([server, info]) => ({
      server,
      connected: info?.status === "connected",
      purpose: PURPOSES[server],
    }));
  } catch {
    // Not being able to list them is not a failure -- the agent still has the
    // tools. It just means the plan cannot mention them by name.
    return [];
  }
}

/** Render the inventory for the research output. */
export function renderCapabilities(list: readonly Capability[]): string {
  if (list.length === 0) return "";

  const connected = list.filter((c) => c.connected);
  if (connected.length === 0) {
    return ["# Available capabilities", "", "No MCP servers are connected to this workspace.", ""].join("\n");
  }

  return [
    "# Available capabilities",
    "",
    "These are connected to this workspace. Their tools are already in your tool list -- use",
    "one when it does the job materially better than you can by hand.",
    "",
    ...connected.map((c) => `- **${c.server}**${c.purpose ? ` — ${c.purpose}` : ""}`),
    "",
  ].join("\n");
}

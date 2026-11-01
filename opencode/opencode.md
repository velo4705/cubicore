# OpenCode Installation

Cubicore runs as an MCP server for OpenCode. This page covers installation,
troubleshooting, FAQs, and AI agent installation.

## Install with npx (recommended)

```bash
npx cubicore@latest setup
```

This installs Cubicore globally (`npm install -g cubicore` or via `npx`), writes the MCP entry to both `~/.config/opencode/opencode.json` (host) and `~/.var/app/ai.opencode.opencode/config/opencode/opencode.json` (Flatpak), sets `enabled: true`, points to `dist/mcp-main.js`, adds the Flatpak filesystem override (`~/Projects/cubicore`), and installs the associate agents (`/cubicore:install`). After it finishes, **restart OpenCode fully** so it picks up the new MCP server.

Then in any project directory, type:

```
/cubicore:plan
```

If the plan prompt appears, Cubicore is installed and working.

## Build from source (for development)

```bash
git clone https://github.com/velo4705/cubicore
cd cubicore
bun install
bun run build
```

Then register the MCP server manually in `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "cubicore": {
      "type": "local",
      "command": ["bun", "run", "/absolute/path/to/cubicore/src/mcp/main.ts"],
      "environment": { "PATH": "/home/you/.bun/bin:/usr/bin:/bin" }
    }
  }
}
```

And install the agents:

```bash
bun run src/mcp/install.ts
```

## Restart OpenCode

The MCP server and agents are loaded at startup. After installing, restart OpenCode entirely.

## Verify

Open OpenCode in a project and type:

```
/cubicore:plan
```

If the plan prompt appears, the plugin, MCP server, and agents are all wired. The
server's working directory becomes the project root for `prepare`, `execute`, and
the check commands.

## AI agent installation

If you are an LLM agent helping a founder who cannot install manually, ask OpenCode
to run the `install` prompt:

```
/cubicore:install
```

This returns step-by-step installation instructions designed for AI agents to follow
on the founder's behalf. The founder still needs to restart OpenCode themselves.

You can also consume [`llms.txt`](../llms.txt) for machine-readable installation guidance.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| **MCP connection refused** | Make sure bun is on PATH (`which bun` should return a path). The npx installer records the bun path it finds. |
| **Plan tool says "no contracts"** | Run from a directory that contains code to split. |
| **`/cubicore:execute` does nothing** | Start OpenCode in the project directory so the MCP server's working directory is the project root. |

## Uninstalling

Remove the `cubicore` entry from `mcp` in `opencode.json`, remove the
`cubicore-associate` and `cubicore-research` agents from the `agent`
section, and remove the plugin from the `plugin` array. Restart OpenCode.

## FAQ

**Q: Do I need both the plugin and the MCP server?**
A: The inline-subtask path requires both. The session path works with the plugin alone.

**Q: Can I install without npx?**
A: Yes — clone the repo, build from source, and register the MCP server manually as shown above.

**Q: How do I know if installation worked?**
A: Restart OpenCode, open any project directory, and type `/cubicore:plan`. If the plan prompt appears, everything is wired.

**Q: Can AI agents install Cubicore for me?**
A: Yes — ask your AI agent to run `/cubicore:install` in OpenCode, which returns step-by-step instructions. You'll still need to restart OpenCode yourself.

**Q: What does `npx cubicore` actually do?**
A: It downloads Cubicore from npm, writes the MCP server entry to your OpenCode config, installs the associate agents, and bounds the primary agent to 120 steps.

**Q: Do I need to reinstall after updates?**
A: Yes — run `npx cubicore` again (or rebuild from source) and restart OpenCode to pick up the new version.

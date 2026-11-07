# OpenCode Installation

Cubicore runs as an MCP server for OpenCode. This page covers installation,
troubleshooting, FAQs, and AI agent installation.

## Install with npx (recommended)

```bash
npx cubicore@latest setup
```

Works on any machine with npm/npx — Windows, macOS, Linux and NixOS.

This installs Cubicore **globally for your user account**. It never writes into a project, and it never touches a different OpenCode variant than the one you pick:

1. It prints the Cubicore banner and asks which OpenCode you have:
   - **Native (CLI / Desktop)** — `~/.config/opencode/opencode.json` (Windows: `%USERPROFILE%\.config\opencode\opencode.json`). Default.
   - **Flatpak** — `~/.var/app/ai.opencode.opencode/config/opencode/opencode.json`. Linux only.
2. It copies the MCP runtime once into a user-global location (`~/.local/share/cubicore/mcp-main.js`; `%LOCALAPPDATA%\cubicore` on Windows, `~/Library/Application Support/cubicore` on macOS). The OpenCode config points there, so nothing depends on the npx cache.
3. It registers `cubicore` in the chosen config's `mcp` block (`type: "local"`, `enabled: true`, absolute bun path) and installs the `cubicore-associate` / `cubicore-research` agents, bounding the primary agent to 120 steps.

**If the chosen OpenCode's config directory is not present, nothing is written** — the script tells you OpenCode is missing (or not properly set up) and stops.

Re-run the same command at any time to update the MCP runtime and refresh the config entry.

For automation, use `npx cubicore@latest setup --native` or `--flatpak`, and `--yes` to skip the prompt. `XDG_CONFIG_HOME`, `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` are honoured when set — the installer follows the same rules OpenCode itself does.

Advanced notes:
- OpenCode injects `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` into MCP servers at launch. You do not need to set them (and you should not put them in the config).
- If `bun` is not on the machine, the MCP entry uses `npx --yes bun` instead — install bun (https://bun.sh) for zero-download starts.
- `opencode.jsonc` is supported; values are preserved, comments are rewritten on save (a backup is left at `opencode.jsonc.cubicore.bak`).
- When both `opencode.json` and `opencode.jsonc` exist, Cubicore installs into `opencode.json`.

After it finishes, **restart OpenCode fully** so it picks up the new MCP server.

Then in any project directory, type:

```
/cubicore:plan-demo
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
| **MCP connection refused** | Make sure bun is reachable — the installer records the absolute bun path it finds (`which bun`). If you installed bun afterwards, re-run `npx cubicore@latest setup`. Without any bun, the entry falls back to `npx --yes bun`. |
| **Config is opencode.jsonc with comments** | Values are preserved; comments are rewritten on save. A backup is written to `opencode.jsonc.cubicore.bak`. |
| **Both opencode.json and opencode.jsonc exist** | Cubicore installs into `opencode.json`. |
| **"OpenCode not found" during setup** | The chosen variant's config directory is absent — install/run OpenCode once, then re-run the command. Nothing was written. |
| **Plan tool says "no contracts"** | Run from a directory that contains code to split. |
| **`/cubicore:execute` does nothing** | Start OpenCode in the project directory so the MCP server's working directory is the project root. |

## Uninstalling

Remove the `cubicore` entry from `mcp` in your OpenCode config, remove the
`cubicore-associate` and `cubicore-research` agents from the `agent`
section, and remove the plugin from the `plugin` array. Delete
`~/.local/share/cubicore` (or the equivalent data directory for your OS).
Restart OpenCode.

## FAQ

**Q: Do I need both the plugin and the MCP server?**
A: The inline-subtask path requires both. The session path works with the plugin alone.

**Q: Can I install without npx?**
A: Yes — clone the repo, build from source, and register the MCP server manually as shown above.

**Q: How do I know if installation worked?**
A: Restart OpenCode, open any project directory, and type `/cubicore:plan`. If the plan prompt appears, everything is wired.

**Q: Can AI agents install Cubicore for me?**
A: Yes — ask your AI agent to run `/cubicore:install` in OpenCode, which returns step-by-step instructions. You'll still need to restart OpenCode yourself.

**Q: What does `npx cubicore@latest setup` actually do?**
A: It prints a banner, asks which OpenCode you run (native CLI/Desktop, or Flatpak on Linux — native by default), copies the MCP runtime to a user-global location, registers it as `mcp.cubicore` in that variant's global config, installs the associate agents, and bounds the primary agent to 120 steps. If the chosen OpenCode is not installed, it writes nothing and says so.

**Q: Do I need to set OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD?**
A: No. OpenCode injects them into MCP servers at launch. If you set them yourself in the config, they win, but there is no need.

**Q: Do I need to reinstall after updates?**
A: Yes — run `npx cubicore@latest setup` again and restart OpenCode to pick up the new version.

# FAQ

## General

**What is Cubicore?**

An MCP server that turns "build me X" into an actual plan, dispatches the work,
gates every result, and refuses to merge anything that fails its checks. It is
not a code generator; it is a planner with workers.

**Do I need to write a spec?**

No. Say what you want in plain words. The planner reads the repo, asks you only
what the repo cannot answer, then writes a plan you review before anything
is built.

**What does the plan look like?**

Three files:

- `CUBICORE_PLAN.md` — for humans to read and edit
- `CUBICORE_PLAN.json` — the dispatchable form (workers contract on this)
- `CUBICORE_CONTEXT.md` — the pitch / user story narrative; never parsed by Execute

**Can I change the plan after it's written?**

Yes — `/cubicore:refine`. Contracts that already passed and kept their write
scopes are not re-dispatched.

**What does "the gate" actually do?**

Checks commands, statuses, and scopes. A failing check, a scope stray, or a
command that never ran means the work is not integrated. It cannot tell you
the feature is *good* — it can tell you the build passed and the scope held.

**Is it "free parallelism"?**

No. Naive fan-out pays the full context price per worker and usually produces
the same bugs in parallel. Cubicore's contract layer is what makes parallel
agents safe instead of fast. Raw speed depends on the host, the model lane,
and the task; published efficiency numbers are deliberately not promised.

## Requirements

**What do I need installed?**

OpenCode — and that's it. Bun optional (recommended for the MCP host itself).
Cubicore installs its own runtime; you never edit your OpenCode config by hand.

**Does it work on Windows / macOS / Linux?**

Yes. The installer writes the right global config per platform:

- Native (CLI / Desktop): `~/.config/opencode/opencode.json`
  (Windows: `%USERPROFILE%\.config\opencode\opencode.json`)
- Flatpak (Linux only): `~/.var/app/ai.opencode.opencode/config/opencode/opencode.json`

**How does it know where my OpenCode lives?**

It checks `XDG_CONFIG_HOME`, `OPENCODE_CONFIG`, and `OPENCODE_CONFIG_DIR`, then
falls back to the defaults above. Flatpak is a separate location and is only
offered on Linux.

## Installation

**The official install worked — how do I update?**

Re-run `npx cubicore@latest setup`. It overwrites the MCP runtime bundle and
refreshes the config entry. Restart OpenCode afterwards.

**Something's off after install — where's the error?**

The installer cannot see your project; OpenCode cannot see hooks the way a
shell can. If an agent isn't appearing:

- Restart OpenCode fully (it caches MCP server connections and agent lists).
- `/cubicore:status` tells you what Cubicore sees, per directory.

**Does the install write secrets into the config?**

No. OpenCode injects `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`
into MCP servers at launch. The installer never puts them in files.

## Behavior

**Does it ever change my files without checking?**

The planner writes three markdown/json files and nothing else before you say
"execute". After dispatch: workers operate inside worktrees, and their writes
are copied back only after the scope gate and checks pass.

**Why do I need git?**

Disjoint scopes and worktrees are git concepts, not wishes. Without git the
isolate degrades to the shared tree and tells you the risk is back.

**Can Cubicore be wrong?**

Yes, and it's built to say so. A check that could not run is reported as
*unverified*, not *passing*. A scope stay that is reported is a finding, not
a silently skipped file.

**What happens when a check fails?**

Worker keeps the work in its own worktree; the failure is recorded with the
command and its output; one bounded retry; then the whole thing stops with a
clear explanation. Cubicore does not paper over failures by weakening checks.

## Troubleshooting

**`npx cubicore@latest setup` 404s / E404**

If you see E404, either your npm cache/registry is holding a stale error, or
you hit this before 1.0.0 existed. Try npm cache clear, or:

```
npm cache clean --force && npx cubicore@latest setup --yes
```

or fall back to the from-source instructions in `opencode/opencode.md`.

**The agent answers but never does anything**

Check the host actually supports dispatch for the role: Flatpak OpenCode
supports inline sub-agents; the native CLI/Desktop path may be session-only.
The planner writes the dispatch blueprint accordingly. Either way, a failure
to dispatch is reported, never faked.

**Nothing works and the MCP server won't start**

- Confirm bun is reachable (`bun --version`); the MCP command in the config
  uses the absolute bun path the installer found at install time.
- Re-run `npx cubicore@latest setup`; if bun moved, it records the new path.
- The runtime bundle lives at `~/.local/share/cubicore/mcp-main.js` — check it
  exists and matches the entry in your OpenCode config.

## Compatibility

**Does it work with Claude Code / Codex / Cursor / Windsurf?**

Not yet. No adapter exists for any of them — nothing is built, not even the
plumbing. OpenCode is the only supported host in this release.

**Can it be scripted, or is it chat-only?**

The MCP prompts are slash commands; the tools beneath are callable by the agent.
There is no headless CLI for Cubicore itself — it is a library + MCP server.

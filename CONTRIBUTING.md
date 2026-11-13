# Contributing

Four kinds of contribution, in order of how welcome they are: **bug fixes,
translations of the README, new/improved commands and features, new host support.** Each
has its own bar. Read the one you care about, not the whole file.

## Setup

```sh
git clone https://github.com/velo4705/cubicore
cd cubicore
bun install
bun test           # must pass before anything else
bun run build      # rebuilds dist/cli.js and dist/mcp-main.js
```

Works on Windows/macOS/Linux with Bun. For anything that touches the MCP
server you also need OpenCode (any install: native desktop, CLI, or Flatpak)
on the machine to try your changes end-to-end.

**A change is complete only when it survives OpenCode's logs.**

## Bug fixes

The bug you found is almost certainly one of these:

- A tool or prompt miscounting what it found (search `TIMEOUT`, `unverified`, `found: false`)
- A gate passing something it shouldn't (search `scope:fail`, `changesUnknown`)
- An installer writing to the wrong place (search `findConfig`, `pickConfigFile`)
- The MCP server dying on a host API change (search `/api/session`, `session_v2`)

Fix it with a failing test *first* if at all possible — the suite is the
fastest way to tell this project from a pile of agent prompts, and a fix
without a test is usually fixed by accident and unfixed on the next commit.

- Tests live in `test/`, one file per area (`test/gate/`, `test/dispatch/`,
  `test/coordinator/`, `test/install*.test.ts`, …).
- `bun test` exits 0 or not. No "it worked here".
- If the bug was a wrong number or a wrong gate, patch the *check*, not the
  test that measures it.
- Do not "improve" unrelated code along the way. Unrelated changes make the
  bug impossible to bisect.

## Adding or improving a command

Commands are typed MCP prompts surfaced as `/cubicore:<name>`. The prompt is
what the founder sees; the tool underneath is what does the work.

1. Add the tool to `TOOLS` in `src/mcp/server.ts`
   (search `name: "execute"` for the exact shape — `inputSchema`, `handler`).
2. Add the prompt to `PROMPTS` (search `PROMPTS = [`) unless you want it
   agent-only, in which case skip this step.
3. Both the tool description and the prompt description must say **when**,
   not what. The host model decides whether to use it from the description;
   "what it does" descriptions are ignored.
4. Tests: `test/commands.test.ts` guards the prompt/tool surface; behaviour of
   the new command needs its own test in `test/`.
5. Docs: `docs/commands.md` is the reference — update it in the same change or
   it's undocumented the moment you merge.
6. If the command takes two questions (e.g. `deploy`: tier, then stack), ask
   them one at a time, never both in one turn. Do not inline what
   `deploy_stack` builds; create it as its own form (`frm_`-prefixed id).

Common shape:

```ts
{
  name: "my_command",
  description:
    "WHEN + "
    "Use only when the user asks for exactly X. Do not reach for this for Y.",
  inputSchema: { … },
  handler: async (args) => { … },
},
```

## Adding an AI agent / host

**The whole point of a host adapter is that the MCP doesn't have to know
what you added it for.** Read `TODO.md` Area 3 — Phase 3 — for the contract: the
adapter must let Cubicore plan → dispatch → gate → integrate without the MCP
caring which host runs the parts.

What you will end up writing:

1. An adapter in `src/adapters/<yourhost>/` implementing the same seams the
   OpenCode adapter implements today (`plugin.ts` — the host SDK boundary,
   `runtime.ts` — config/service discovery).
2. Host detection in the installer (`src/install/targets.ts`) so
   `cubicore setup` can find it.
3. Install smoke proving the installer actually wrote there (workflow:
   `.github/workflows/install-smoke.yml`, or just prove it by hand).
4. Anything the host *cannot* do, reported as such — never faked. If the
   host can't isolate a worktree, say so in capabilities; if it can't run
   inline sub-tasks, use the sessions fallback; if it can't do either, the
   adapter should refuse, not pretend.

**Measure before claiming.** The moment you have a working adapter, do not
write "Cubicore on MyHost is fast" anywhere in this repo. The benchmarks were
retired because they measured nothing a founder could trust; the only
acceptable numbers are: did the work land, did the gate pass, what did the
wall-clock and token cost look like — for that host, that model. If you don't measure, don't claim.

Wind down: adapters merged for hosts with no active users are removed. If
it's a design sketch, make it a design sketch — don't merge a broken
candidate "temporary".

## Translating the README into other languages

**This is about translating `README.md` into a language other than English** — nothing else. `docs/`, `llms.txt`, and `opencode/opencode.md` are reference material and stay in English.

- File naming: `README.<lang>.md` next to the original (`README.fr.md`, `README.de.md`, `README.ja.md`, `README.zh-CN.md`, `README.hi.md`, …), using the BCP 47-ish short code you'll see in most open-source projects.
- Translate the prose. Keep in English, verbatim:
  - commands (`npx cubicore@latest setup`, `/cubicore:plan-demo`, …),
  - flags and filenames (`--native`, `--flatpak`, `CUBICORE_PLAN.json`, …),
  - headings whose anchor links are used elsewhere (only the prose under them changes),
  - code blocks, URLs, and shell examples.
- A translation is prose-faithful, not a rewrite — same order, same claims, same honesty. If you think a claim needs changing, that happens in the English original first, by review; don't fix it silently in a translation.
- No benchmark or efficiency numbers — they don't exist in the original either, and none should appear.
- Link the two: the translated file links back to the English README at the top, and the English README footer gains a line like `README in French: [Français](README.fr.md)` once yours lands.
- One commit per section (or one logical chunk), not one giant "translate README" commit — reviewable and revertable.
- Tone: plain and direct. A professional voice is enough; don't inflate it with marketing. If the original says "Works on Windows, macOS, Linux and NixOS", the translation should say the same thing, in the plainest words your language has for it.

## Code style

- `src/` is TypeScript; `bun` handles both build and test.
- The MCP server is a library, not a daemon. No global state, no network
  writes to non-OpenCode endpoints, no silent fallbacks.
- Never swallow an error: if you cannot tell why something failed, say so —
  `unverified` is a finding, not an absence of a finding.
- Don't add features to "finish" unrelated work in a drive-by PR. Separate
  branches, separate PRs.

## Local checks before pushing

```sh
bun test            # green, always
bun run typecheck   # pre-existing errors are tolerated; yours are not
bun run build       # proves the shipping artifact still builds
```

## What gets rejected, without appeal

- README edits that invent numbers, benchmark ratios, or host support that
  doesn't exist (the two original sin reasons for the README rewrites).
- "New host support" that doesn't handle install + smoke + a real session on
  that host, or that silently fakes what the host can't do.
- Features merged without tests when the area has tests.
- Reverting the benchmark retirement without a working measurement plan.

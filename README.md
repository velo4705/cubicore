# Cubicore

What if you wished to make a "company" right at home, where you are the founder of the project, and your fellow sub-agents do the work for you?

Enter Cubicore, A Dynamic Multi-Agent Factory System that interacts with Sub-tasks and Sessions (if present). The system is designed as an MCP for enhanced portability across multiple AI agents - Opencode or Claude Code, to name a few.

## What is the idea?

Suppose you imagine a magic "cube", as an example. Act that this cube is a "mini" company that is under your control. Then, you ask the "magic cube" about what you want. It can be anything - even a multimillion SaaS product would be fine. After you reply to the "magic cube", the cube plans and determines the size of your project, and size of your project matters for how many "employees" that will be hired for this job.

Once its all set, the cube resizes and fills it with new "employees" to work on each task the "cube" has been told to provide. It also asks about what style or layout you really want, or maybe you can also ignore it to have the "cube" give the best style it can think of!

The project is done when all sub-tasks are done, but hey, you can even call the testers to test the product you made, just to make sure no bugs, broken interactions, fixable warnings are left behind. You can add any feature you wanted by asking the "magic cube" again, and it will do it for you. It doesn't matter how many decorations you add onto the "magic cube", it will always be better with its "add-ons".

## How it Works?

Like the Idea, Cubicore is the definition of "Cores in a Cubicle", which are called "Cubicores". These "cubicores" represents Inline Sub-tasks or Sessions run by the agent at the same time (it is never one-by-one). 

A Brief idea of this project works like so:

```
[User gives Prompt] --> [Agent Plans about the Prompt and generates file] --> [Summon Sub-agents to read generated file] --> [Submits Result]
```

And the Actual process is shown here as a diagram:

```mermaid
flowchart TD
    A[Founder request] --> B[/cubicore:plan]
    B --> C{Plan valid?}
    C -->|No| B
    C -->|Yes| D[/cubicore:execute]
    D --> E[Worktree isolation per associate]
    E --> F[Schema gate]
    F --> G[Verify gate]
    G --> H[Scope gate]
    H --> I{All gates pass?}
    I -->|No| J[/cubicore:refine]
    J --> D
    I -->|Yes| K[/cubicore:test]
    K --> L{Blocking findings?}
    L -->|Yes| M[/cubicore:fix]
    M --> D
    L -->|No| N[/cubicore:try]
    N --> O{Works?}
    O -->|No| D
    O -->|Yes| P[/cubicore:deploy]
    
    Q[/cubicore:status] --> D
    R[/cubicore:estimate] --> D
    S[/cubicore:undo] --> D
    T[/cubicore:cancel] --> D
```

When a user gives a prompt, assume it to be a simple, lazy prompt "Make me some huge megaproject that can make me rich. make no mistakes, i believe in you.".
Using the prompt provided by the User, and Main agent will Plan and research about the project on what you are meaning to build... and will ask further questions about the type of product, the style, the layout, the tech stacks, anything... even the questions would be marked "Recommended" to be selected very easily.
After when its done, it finally determines the Project Size, displays the tasks, where each task (they are no small tasks) is assigned to a particular "cubicore". It also gives out the N number of cubicores required to build your project from scratch. This is all mentioned in the PLAN.md file for every "cubicore", even the "founder" (The user) to see. 

Once done, Hit the "execute" command - The Main agents summon the N "cubicores" as if its constructing an urgent megaproject. These sub-tasks fill in the gaps by finishing its tasks, and avoid conflicts with other workers in the process.

In the end, It finally gives the result you (the founder) wanted. You can try the "test" command to go even further, by asking the Main agent to summon testers for your project, to make sure all broken interactions, and errors, and fixable warnings are recorded in the DEBUG file. Again, anyone is free to see the DEBUG file, as it shows how many problems it has been encountered through the corners of your masterpiece.

After this, Run the "fix" command, and it starts fixing the issues by reading the DEBUG file. These two commands: "test" and "fix" are basically "rinse-and-repeat" - which means once errors are fixed, the next time when the user retests the project and its codebase, it shouldnt have a DEBUG file present.

About the "decorations", Cubicore is meant to have excellent support for plugins and MCPs that can assist the work with new and unique commands running, or possibly reducing tokens along the way. Regardless, it makes the Project even better, and doesnt waste anything.

## Supported AI Agents

Currently, we only support Opencode for now.

| AI Agent | Status | Progress |
|---|---|---|
| Opencode | ✅ | Works end to end — MCP plan/execute/test, inline sub-tasks, sessions |
| Claude Code | 🔶 | MCP is portable; the host-dispatch path is written but unverified |
| Codex | 🔶 | Same MCP surface, unverified |
| Cursor | ❌ | No inline sub-tasks; would use the session path |
| Windsurf | 🔶 | Inline sub-tasks available, unverified |

## Commands

| Command | What it does |
|---|---|
| `/cubicore:plan` | Research the repository, ask the founder what the repo cannot answer, then write `CUBICORE_PLAN.md` and `CUBICORE_PLAN.json`. Dispatches nothing. |
| `/cubicore:execute` | Dispatch the plan — one brief per associate, summoned in parallel, each result gated. Prefers the host's own inline sub-agents so every associate renders as a visible step; falls back to Cubicore's own sessions when the host has none. |
| `/cubicore:test` | Run the mechanical matrix over the delivered work and write `CUBICORE_DEBUG.md`. Errors and warnings block; judgement calls are reported and never block. |
| `/cubicore:refine` | Change the current plan before running it, or add a feature to a project that has already been built. Contracts that already passed and were left alone are not re-run, so the second cycle costs the change and not the project. |
| `/cubicore:fix` | Fix what the test command found. Reads `CUBICORE_DEBUG.md`, plans the fixes and dispatches them — the work is already decided, so it skips the re-planning and the checks that are already green. |
| `/cubicore:estimate` | What the plan will cost before anything is spent: how many associates, the token and wall ceilings, and who owns what. It is the plan's own budget, not a forecast. |
| `/cubicore:undo` | Undo the last execution — discard its changes and return the tree to the baseline commit Cubicore recorded. Destroys work, so it says what it will destroy first. |
| `/cubicore:cancel` | Cancel a run. The associates that have not finished are stopped and the rest are marked skipped. The work already on disk stays. |
| `/cubicore:deploy` | Plan the deployment. Asks about the tier, offers stacks with a recommendation, writes the deploy files, and explains the manual steps. Deploys nothing. |
| `/cubicore:try` | Run the delivered thing and say whether it actually works, using the plan's own `try` block. A contract can be correct and still not run. |
| `/cubicore:status` | Report what the run in flight is doing, and wait for it if it is not finished. |

### The flow guides itself

After every step the agent ends its reply with what to type next, and the alternatives — the recommended one first. It is derived from the state on disk, so it survives a restart and a new session days later.

```
no plan            /cubicore:plan
after plan         /cubicore:execute   · estimate · refine
run in flight      /cubicore:status
after the run      /cubicore:test      · refine · undo
blocking findings  /cubicore:fix       · refine · undo
everything passes  /cubicore:deploy    · refine · undo
```

## Installation

Cubicore runs as an opencode plugin **and** an MCP server. Both are required
for the inline-subtask path; the session path works with the plugin alone.

### 1. Build the plugin

```bash
git clone https://github.com/velo4705/cubicore
cd cubicore
bun install
bun run build          # produces dist/index.js
```

### 2. Register the MCP server in opencode

Add to your opencode config (`~/.config/opencode/opencode.json`):

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

The command must point at `src/mcp/main.ts` (not a compiled output) so the
server reloads on every code change. The `PATH` must include your bun binary
and the system paths.

### 3. Install the Cubicore agents into opencode

```bash
bun run src/mcp/install.ts
```

This writes `cubicore-associate` and `cubicore-research` into your opencode
config and sets `build.maxSteps: 120`. If you ever rebuild the plugin, run
this again so the agent definitions stay current.

### 4. Restart opencode

The plugin and MCP server are loaded at startup. After editing
`opencode.json` and running the installer, restart opencode entirely.

### 4. Verify

Open opencode in a project and type:

```
/cubicore:plan
```

If the plan prompt appears, the plugin, MCP server, and agents are all
wired. The server must run in the project you want to work on — its working
directory becomes the project root for `prepare`, `execute`, and the check
commands.

### Troubleshooting

- **MCP connection refused**: check the `command` path and that `bun` is on
  the `PATH` inside opencode.
- **Plan tool says "no contracts"**: the research tool found nothing to
  split. Run the plan command from a directory that contains the work
  (e.g. a `sources/` directory for the docs fixture).
- **`/cubicore:execute` does nothing**: the MCP server's working directory
  must be the project root. Start opencode *in* the project directory.

### Uninstalling

Remove the `cubicore` entry from `mcp` in `opencode.json`, remove the
`cubicore-associate` and `cubicore-research` agents from the `agent`
section, and remove the plugin from the `plugin` array. Restart opencode.

### How the associates are kept apart

Three layers, and only the first was ever airtight.

**At plan time**, the validator rejects overlapping write scopes before a token is spent. It is a conservative over-approximation — `src/routes/` and `src/routes/users.ts` collide, `src/a.ts` and `src/b.ts` do not — because over-reporting costs one re-plan while under-reporting costs a merge conflict.

**During the work**, each associate gets its own git worktree, so two workers cannot be in one file at the same moment. The session is created and prompted there, and the contract's declared writes are copied back only after its checks pass. Because the scopes are disjoint, that copy cannot conflict. Where git is unavailable the isolate degrades to the shared tree and says so.

**After the work**, the scope gate checks what actually changed against what was declared. A worker that strayed is caught, and a check that could not run at all is reported as unverified rather than as a failure — no evidence either way, and not retryable, because a revision cannot install a missing dependency.

opencode 1.18.x cannot restrict an agent to a path — its permissions are per-action, not per-resource — so the filesystem is the only boundary available.

## What Cubicore is for

The honest claim, in three parts.

**Splitting work without coordination is not free parallelism.** Measured
against one agent doing the same job, twelve uncoordinated workers cost
**10.9× the tokens and were 2.6× slower**. Every worker loaded the whole
repository into its own context and nothing stopped them colliding.

**Cubicore fixes the cost side.** Against the same twelve-worker fan-out,
Cubicore was **3.5× cheaper** — narrower write scopes, so each worker reads
only what its contract needs instead of the whole repository. The naive arm
spent 96.0M tokens on cache reads; Cubicore spent 25.0M, for the same twelve
workers. That difference is the contract layer and nothing else.

The wall-clock comparison is *not* clean, and Cubicore does not claim it: the
naive arm was capped at three concurrent workers and Cubicore dispatched all
twelve, so most of the 2.9× gap is that cap rather than the contract layer.
Cubicore has no concurrency cap of its own yet, so the fair comparison could
not be run as written.

**But Cubicore does not beat one agent.** On twelve small files it was level
on wall clock and cost 3.1× the tokens. The work was too small to need parallel
workers, and the model was the bottleneck, not the split.

So the value is conditional, and the condition is about the work rather than
about Cubicore:

| Situation | Cubicore is |
|---|---|
| Several hours of genuinely independent work | worth it — 3.5× cheaper than naive fan-out |
| A couple of hours, or one sitting | overhead — 3.1× the tokens for parity |
| Coupled work, a shared core, an integration step | refuses it — the topology check catches it before a token is spent |
| One agent, done in one pass | overhead, and the plan says so |

The "9 hours becomes 4" shape is real against the right control, but it is not
"because of splitting". Splitting is what makes the naive version slow. Cubicore
is what makes splitting pay. And the ceiling is below 9→4 for most projects,
because Amdahl's serial fraction does not parallelise and the gates cost
something too.

**And the real value is not speed.** It is that four agents can work on the same
repository without colliding, and that "done" means the checks passed rather
than that a model said so. The speedup is a side effect.

Full numbers and the caveats: [bench/RESULTS.md](bench/RESULTS.md).

## What exists

- **Contracts, not prompts.** Disjoint write scopes, a check matrix computed at
  validation time, budget caps, and a topology check that refuses work which is
  not divide-and-conquer.
- **Two dispatch paths.** Inline sub-tasks where the host supports them, sessions
  where it does not. Both gate the same way.
- **One worktree per associate.** opencode 1.18.x cannot restrict an agent to
  a path, so the filesystem is the boundary: two workers cannot be in one file
  at the same moment. A worker's files are copied back only after its checks
  pass, so an unapproved change never reaches the shared tree.
- **Nine commands, and the flow guides itself.** Every reply ends with the
  next step and the alternatives, derived from the state on disk rather than
  remembered.
- **A bounded loop.** `plan → execute → test → execute`, capped at three
  cycles. Not "until the debug file is empty" — that is an unbounded loop whose
  terminal case is an agent that never stops finding things to fix.
- **Judgement never blocks.** Errors and warnings block. "Is this useful" and
  "is this production ready" are recorded as advisory and left to the founder.

## Known limits

- **v1 catches mechanical failures only.** No `judgment` checks are admitted;
  the validator rejects them. Whether a feature is *useful* is not something
  the matrix can decide.
- **X and Y are measured, but not in one controlled run.** The three arms have
  each run against the same fixture, and the ratios are large enough to
  survive that — but the digits do not come from one clock.
  - **Y**, total tokens against naive fan-out: **0.29**
  - **X**, per-worker cost against naive fan-out: **0.29**
  - Wall clock against naive fan-out: **2.9× faster** — ⚠ confounded, the
    naive arm ran three-wide and Cubicore ran twelve-wide. Do not quote it.
  - Against a *single* agent: parity on wall clock and **3.1× more tokens**
- **The inline path's shell is still unrestricted.** opencode 1.18.x cannot
  restrict an agent to a path, so a worker with a shell can run anything. The
  worktree contains the damage — a stray file stays in the worker's own
  checkout and is not copied back — but the command still ran.


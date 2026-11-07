# Commands

Cubicore is a single MCP server with two faces: **tools** (what the agent calls)
and **prompts** (what you type as slash commands). You invoke the prompts;
this document is the prompt reference.

Slash commands are rendered by the host that supports them. If your OpenCode
doesn't render them, ask the agent to call the underlying tool by name
(`cubicore_plan_demo`, `cubicore_execute`, …).

## Quick guide

| You want | Type |
|---|---|
| Start with nothing | `/cubicore:plan-demo` |
| Start with everything | `/cubicore:plan-full` |
| Build it | `/cubicore:execute` |
| Check it's running | `/cubicore:preview` |
| Review & fix it | `/cubicore:debug` |
| Change the plan | `/cubicore:refine` |
| Know the cost before spending | `/cubicore:estimate` |
| Resume an interrupted run | `/cubicore:continue` |
| What's happening now | `/cubicore:status` |
| Throw the last execution away | `/cubicore:undo` |
| Ship it | `/cubicore:deploy` |

Argument rules: everything you type after the command is forwarded verbatim —
including multi-word requests. Plans are read from disk (never pasted), and
`planNumber` selects a member plan file (`CUBICORE_PLAN_N.json`).

## Reference

### `/cubicore:plan-demo <request...>`
Plan a demo or MVP: research the repo, ask the founder what the repo cannot
answer, then write the plan.

- **Inputs:** everything typed after the command, verbatim.
- **Writes:** `CUBICORE_PLAN.md`, `CUBICORE_PLAN.json`, `CUBICORE_CONTEXT.md`.
- **Dispatches nothing.** You review first — this is the point of the step.

### `/cubicore:plan-full <request...>`
Same flow, scoped as a production project: deeper contracts, health endpoints,
observability, checks that can fail against real systems.

### `/cubicore:execute [plan | planNumber]`
Dispatch the plan — one associate per contract, gated, integrated.

- Reads `CUBICORE_PLAN.json` by default.
- Pass inline JSON as `plan` to run a one-off plan, or `planNumber` to dispatch
  `CUBICORE_PLAN_N.json` (e.g. a team member's slice of a larger plan).
- **Inline sub-agents** where the host supports them, **sessions** otherwise.
  Both gate the same way.
- Work happens in a git worktree; the associate's declared writes are copied
  back only after its checks pass.

Exit outcomes: done, or reported blocked with the exact reason. No silent partials.

### `/cubicore:refine <change...>`
Change the current plan, or add features to something already built.

- Contracts that passed and were left alone are not re-run. The second cycle
  costs the change and not the project.
- Use this — not `plan-demo` — when you already have a plan.

### `/cubicore:estimate`
What the current plan will cost before anything is spent: associates, token and
wall ceilings, and who owns what. These are the plan's own ceilings, not a
forecast — treat them as limits, not quotes.

### `/cubicore:continue [planNumber]`
Resume after an interruption. Skips contracts already done, dispatches what
remains. Reads `CUBICORE_PLAN.json` by default (or `CUBICORE_PLAN_N.json` with
a plan number). Budget-exempt — resuming never spends a cycle to discover how
far it got.

### `/cubicore:debug`
Review, test and fix the delivered work — it exercises the interactive surfaces
the founder would use: web click-through with console capture, CLI invocations,
TUI keys, GUI controls.

- **Console errors**, dead commands, and broken UI are blocking findings.
- **Judgement calls** ("is this useful?") are recorded advisory, never block.
- Repeats until the same failure stops reproducing; then writes
  `CUBICORE_DEBUG.md`.

### `/cubicore:preview [plan]`
Run the delivered thing and keep it available — web via localhost HTTP, CLI via
its output, TUI/GUI via the interface. Uses the plan's own `preview` block.
A contract can be correct and still not run; this catches that.

### `/cubicore:deploy`
Plan the deployment. Two questions, one at a time, as native MCQs where the host
supports them: **which tier**, then **which stack** with a recommendation and
tradeoffs. Writes the deploy files, and explains the manual steps that remain.
Deploys nothing — it prepares what you hand to the host.

### `/cubicore:status [runId]`
Report the run in flight — planned / finished / failed / skipped contracts —
and wait if it isn't finished. If something failed, says which contract to
pick apart next (`/cubicore:debug` or `/cubicore:refine`).

### `/cubicore:undo`
Undo the last execution. Discards its changes and returns the tree to the
baseline commit Cubicore recorded. **Destructive** — it says what it will
destroy first.

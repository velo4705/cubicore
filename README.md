<div align="center">

# Cubicore

</div>

Cubicore is a Dynamic Multi-Agentic Factory of Sub-agents tasked to make a project, utilizing the Decrease-and-Conquer Technique.

---

What if you wished to make a "company" right at home, where you are the founder of the project, and your fellow sub-agents do the work for you? Cubicore does that for you. It is an MCP having commands required to finish your project, quicker.

## Introduction

Cubicore is originated as "Cores in a Cubicle", and informally, "A Fleet of Engineers in a Company". The "Cubicle" in this idea is Dynamic, which increases its size dynamically, depending on the plan on the **size of the project**.

The Core philosphy it presents is simple: Suppose a user gives a prompt to the "Cubicle". The "Cubicle" changes its size according to what the user said about. The size stops increasing when the planning is done, and all is left is to wait for the user to "execute" the plan.

This upon execution will summon sub-agents, where 1 task is recieved by 1 agent. This eventually fills up the "Cubicle" where all tasks are done simultaneously. The execution is done where all sub-agents have completed their tasks provided in the planning file.

Cubicore can debug any broken layout, buttons, syntax errors, loose code, etc. and fix them automatically until issues disappear. Cubicore also allows the user to "preview" its project to see how it runs. Finally, if the user satisfies with the project, it then commands the "Cubicle" to deploy the application, making things ready while also giving instructions on how to deploy.

---

## Supported AI Agents

Currently, we only support Opencode for now.

| AI Agent        | Status | Progress                                                               |
|-----------------|--------|------------------------------------------------------------------------|
| Opencode        | ✅     | Done Further token reduction and Optimize productivity of sub-tasks.   |
| Claude Code     | ⏰     | Will be implementing Inline Sub-tasks. Not Started.                    |
| Codex           | ⏰     | Has Inline-Sub tasks; Needs Further token reduction. Not Started.      |
| Cursor          | ⏰     | Uses Sessions; Tedious to implement as first Session-only integration. |
| Windsurf        | ⏰     | May use Inline Sub-tasks or Sessions. Not Started.                     |

More agents are coming soon!

---

## 🧪 Lazy Prompt Examples

You don't need to write a spec. Just say what you want in plain words — Cubicore
passes your exact request to the planner, researches your repo, asks clarifying
questions, scopes down to an MVP, and writes a plan you review before anything
is built. Cubicore builds what you ask for — a todo app stays a todo app, not
an expense tracker.

### Solo — Demo (`/cubicore:plan-demo`)

> "Make me a simple todo app that works in the browser."

Cubicore will **not** just build a todo app. It follows this order:

1. **Prepare** — initialises git and records a baseline (or leaves an existing repo alone)
2. **Research** — reports the tree, modules, and their exports; no shell exploring afterwards
3. **Decide scope** — demo/MVP, conventional boring stack, one contract per file or feature, fewer larger contracts over many small ones
4. **Write plan** — `CUBICORE_PLAN.md` (for you), `CUBICORE_PLAN.json` (dispatchable), `CUBICORE_CONTEXT.md` (for presenting in person)

The plan includes a `summary` (one or two sentences at the top of `CUBICORE_PLAN.md`), a `context` field (problem, users, use cases, benefits, demo flow, future work — never affects what gets built), disjoint `writes` per contract, at least one failing check per contract, and a `graphBudget` sized to the contracts.

**Dispatch nothing** — you review the plan first.

Then run `/cubicore:execute` to build it, `/cubicore:preview` to leave it running, and
`/cubicore:debug` to review/test/fix it.

### Solo — Full (`/cubicore:plan-full`)

> "Build me a personal finance tracker with categories, monthly summaries, and CSV export."

Same four steps, but scoped as a full product with 6–12 contracts (API, frontend,
storage, checks). Review the plan before dispatching.

Then run `/cubicore:execute` → `/cubicore:debug` → `/cubicore:preview` → `/cubicore:deploy`.

### Team of 3 — Demo (`/cubicore:plan-demo` then split)

> "Make a hackathon project board where our team can drop ideas and vote on them."

After the plan is written, split it across the team:

```
/cubicore:execute    planNumber 1   # Member A: frontend board UI
/cubicore:execute    planNumber 2   # Member B: voting logic + API
/cubicore:execute    planNumber 3   # Member C: idea storage + export
```

Each member works in their own worktree with disjoint write scopes — no merge
conflicts. Use `/cubicore:status` to check a run, `/cubicore:continue`
with `planNumber` to resume after interruptions.

### Team of 3 — Full (`/cubicore:plan-full` then split)

> "Build a client portal for our small design agency: client login, project uploads, invoice PDFs, and a dashboard."

After the plan is written:

```
/cubicore:execute    planNumber 1   # Member A: auth + client portal UI
/cubicore:execute    planNumber 2   # Member B: uploads + invoice generation
/cubicore:execute    planNumber 3   # Member C: dashboard + reporting
```

Each member works in their own worktree with disjoint write scopes — no merge
conflicts. Use `/cubicore:status` to check each run, `/cubicore:continue`
with `planNumber` to resume after interruptions.

---

## Commands

| Command | What it does |
|---|---|
| `/cubicore:plan-demo` | Demo mode. Research the repository, ask the founder what the repo cannot answer, then write `CUBICORE_PLAN.md` and `CUBICORE_PLAN.json`. Dispatches nothing. **Use for a fresh start; `refine` to change an existing plan.** |
| `/cubicore:plan-full` | Full product mode of the command above. **Use for a fresh start; `refine` to change an existing plan.** |
| `/cubicore:execute` | Dispatch the plan — one brief per associate, summoned in parallel, each result gated. Pass `plan` (inline JSON) or `planNumber` (reads `CUBICORE_PLAN_N.json` from disk). `planNumber` is optional: omit it to run the inline plan, or pass a number to dispatch a member plan file. Enforces the cycle budget and cross-plan validation when reading from disk. |
| `/cubicore:continue` | Resume the last run from where it stopped — skips contracts already done, dispatches only what remains. Exempt from the cycle budget. Reads `CUBICORE_PLAN.json` by default, falls back to `CUBICORE_PLAN_1.json`, or `CUBICORE_PLAN_N.json` when a plan number is given. |
| `/cubicore:debug` | Review, test, and fix the delivered work until the issues disappear. Runs the mechanical matrix, records findings, and attempts narrowly-scoped fixes. Errors and warnings block; judgement calls are reported and never block. Writes `CUBICORE_DEBUG.md`. |
| `/cubicore:refine` | Change the current plan before running it, or add a feature to a project that has already been built. Contracts that already passed and were left alone are not re-run, so the second cycle costs the change and not the project. |
| `/cubicore:estimate` | What the plan will cost before anything is spent: how many associates, the token and wall ceilings, and who owns what. It is the plan's own budget, not a forecast. |
| `/cubicore:undo` | Undo the last execution — discard its changes and return the tree to the baseline commit Cubicore recorded. Destroys work, so it says what it will destroy first. |
| `/cubicore:deploy` | Plan the deployment. Asks about the tier, offers stacks with a recommendation, writes the deploy files, and explains the manual steps. Deploys nothing. |
| `/cubicore:preview` | Keep the delivered thing running: start/keep a localhost server for web apps, or run the built software. A contract can be correct and still not run. Uses the plan's own `preview` block. |
| `/cubicore:status` | Report what the run in flight is doing, and wait for it if it is not finished. |

**Quick command guide:** `plan-demo`/`plan-full` = fresh plan (always writes from scratch; note warns if plan exists); `refine` = edit existing plan (adds/changes without destroying); `execute` = dispatch; `preview` = keep it running; `debug` = review/test/fix; `undo` = discard; `continue` = resume; `estimate` = budget; `deploy` = deploy plan; `refine` = add/change features. Use the right one — `refine` is the mandatory iterative-editing command; it does jobs no other command can do.

### The flow guides itself

After every step the agent ends its reply with what to type next, and the alternatives — the recommended one first. It is derived from the state on disk, so it survives a restart and a new session days later.

```
no plan            /cubicore:plan
after plan         /cubicore:execute   · estimate · refine
run in flight      /cubicore:status
after the run      /cubicore:preview   · debug · refine · undo · continue
issues found       /cubicore:debug     · refine · undo · continue
everything passes  /cubicore:deploy    · refine · undo
```

---

## Installation

Copy the installation instructions from this README (see the **Installation** section above) to set up Cubicore manually. The `install` prompt has been removed; LLM agents assisting a founder can simply copy these instructions directly.

See [OpenCode Installation](opencode/opencode.md) for full installation instructions,
troubleshooting, FAQs, and AI agent installation.

### How the associates are kept apart

Three layers, and only the first was ever airtight.

**At plan time**, the validator rejects overlapping write scopes before a token is spent. It is a conservative over-approximation — `src/routes/` and `src/routes/users.ts` collide, `src/a.ts` and `src/b.ts` do not — because over-reporting costs one re-plan while under-reporting costs a merge conflict.

**During the work**, each associate gets its own git worktree, so two workers cannot be in one file at the same moment. The session is created and prompted there, and the contract's declared writes are copied back only after its checks pass. Because the scopes are disjoint, that copy cannot conflict. Where git is unavailable the isolate degrades to the shared tree and says so.

**After the work**, the scope gate checks what actually changed against what was declared. A worker that strayed is caught, and a check that could not run at all is reported as unverified rather than as a failure — no evidence either way, and not retryable, because a revision cannot install a missing dependency.

opencode 1.18.x cannot restrict an agent to a path — its permissions are per-action, not per-resource — so the filesystem is the only boundary available.

---

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

---

## What exists

- **Contracts, not prompts.** Disjoint write scopes, a check matrix computed at
  validation time, budget caps, and a topology check that refuses work which is
  not divide-and-conquer.
- **Narrative context.** `CUBICORE_CONTEXT.md` — problem, users, use cases,
  benefits, demo flow, future work, market opportunity, business model,
  competitive advantage, go-to-market, risks, current status, and the ask.
  Written for humans who present the project in person; never parsed by
  Execute or dispatch.
- **Two dispatch paths.** Inline sub-tasks where the host supports them, sessions
  where it does not. Both gate the same way.
- **One worktree per associate.** opencode 1.18.x cannot restrict an agent to
  a path, so the filesystem is the boundary: two workers cannot be in one file
  at the same moment. A worker's files are copied back only after its checks
  pass, so an unapproved change never reaches the shared tree.
- **Fourteen commands, and the flow guides itself.** Every reply ends with the
  next step and the alternatives, derived from the state on disk rather than
  remembered.
- **A bounded loop.** `plan → execute → debug → execute`, capped at three
  cycles. Not "until the debug file is empty" — that is an unbounded loop whose
  terminal case is an agent that never stops finding things to fix.
- **Judgement never blocks.** Errors and warnings block. "Is this useful" and
  "is this production ready" are recorded as advisory and left to the founder.

---

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

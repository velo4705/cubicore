# Completed milestones — archived

Removed from ROADMAP.md and MILESTONE.md because the work is done (or the
exit criteria are met in code, with verification as noted per entry) and the
documents should carry only what is unfinished. Kept for history, evidence
and the design rationale — not for re-doing.


## ROADMAP Phase 1 — Contracts and the plan validator

## Phase 1 — Contracts and the plan validator

**This is the moat.** opencode already provides dispatch; nothing validates the
plan before the spend.

Status: **done** — 87 tests. Remaining: the serial *execution* fallback itself
needs `dispatch/`, which is Phase 2. Today `producePlan` returns
`{kind: "fallback"}` and nothing acts on it yet.

Scope:
- `Contract` type (see `src/contracts/types.ts`)
- `validatePlan()` — required fields, disjoint file ownership, budget ceiling
- Structural glob overlap detection
- Coordinator prompt that emits contracts as JSON against a schema
- `parsePlan()` runtime shape check, so malformed output is rejected before
  validation rather than crashing it
- One re-plan attempt with findings fed back, then `fallback`
- Check matrix: `baseline ∪ contract_checks` by construction
  (`src/validate/matrix.ts`), reject `judgment` in v1
- `severity` replaced by `gating` + `convergent`; `verify` dropped in favour of
  at least one blocking check

Exit criteria:
- A plan with two workers owning the same file is rejected before any dispatch
- A diff contract with no blocking check is rejected
- Malformed coordinator output fails to a serial fallback, not a crash
- A planner that cannot converge hands back rather than spending forever

Explicitly out of scope: workers, budgets, review.

---


## ROADMAP Phase 2 — Dispatch and gates

## Phase 2 — Dispatch and gates

Status: **complete** — 189 tests. One unverified SDK seam remains by design.

Scope:
- Map contracts → opencode agent definitions (`mode: subagent`, `hidden: true`)
- Translate `writes` / `forbidden` into V2 `permissions` rules, fail-closed: a
  broad `edit: deny` first, narrow allows, forbidden re-denied after
- Gates in order: `schema` → `verify` → `scope`
- One retry total per contract, then annotate `unresolved`
- Structured artifacts; aggregator reads artifacts, never transcripts
- `prompt.ts` renders a contract into what the worker actually reads — the
  enforcement and the comprehension are stated separately, because globs enforce
  and prose is what stops a worker arguing with them

The SDK seam is smaller than planned. The plugin's `event` hook already delivers
every event, so usage, tool counts and changed files are reconstructed by
`observe.ts` with no client call. `spawn.ts` is three method names
(`create` / `prompt` / `changedFiles`) inferred from the CLI docs.

Design notes worth keeping:
- `gateScope` is new and not in the original three-gate list. It checks the
  worker stayed inside its declared `writes`, which is the runtime counterpart to
  the plan-time disjointness check — the validator proves workers don't *plan* to
  collide, this proves one didn't write where it said it wouldn't. It is never
  retryable: rerunning reproduces the same escape.
- A worker that escapes scope is **not** rolled back in v1. The finding is
  recorded and surfaced; undoing arbitrary edits safely is a Phase 3 problem.
- `failed` and `budget-exhausted` are separate statuses. A worker killed at its
  ceiling must not read as a successful one.

Exit criteria — all met:
- Workers run concurrently and produce schema-valid artifacts
- A worker that fails `verify` is retried once, then flagged, never silently included
- A worker writing outside `writes` is caught by `gateScope`
- Aggregator demonstrably never sees a worker transcript

---


## ROADMAP Phase 5 — Topology selection

## Phase 5 — Topology selection

Status: **done** — 292 tests.

Scope:
- `coordinator/topology.ts` — dependency detection, stage ordering, cycles
- `checkTopology()` validates the planner's declaration against the plan's own
  structure, wired into `producePlan` as `mis-declared-topology`
- Interface-first falls out of the ordering: the producer stage runs first, so a
  shared signature is published before consumers code against it
- Sequential pipeline carries no speedup claim

**The signal is one relation, and it is mechanical:**

> if contract A writes a path that contract B reads, B depends on A.

That single fact does three jobs. It distinguishes fan-out from pipeline, it
orders the pipeline for free via topological stages, and — via a dependency
**cycle** — it proves non-decomposability outright. A cycle means two contracts
each need the other's output, which is precisely the shape "this is not a
divide-and-conquer task" describes. The planner is told to return `refuse`, not
silently overridden.

Phase 5 does not try to out-think an LLM with a classifier. It checks the
declaration against repo structure, because the planner has not read the code and
a plausible-sounding `fan-out` over dependent contracts produces a runtime
failure no amount of re-planning fixes.

`overlaps()` is reused for the dependency test, so detection errs toward
over-detecting dependencies. Over-detecting costs a stage; under-detecting costs
a broken build.

Exit criteria — met:
- Refusal to split is reachable and exercised
- A dependent plan declared as fan-out is rejected before any spend
- Cycles are detected and reported as non-decomposable
- Stage ordering publishes producers before consumers

---


## MILESTONE Phase 1 — Make the current system clearly a factory

### Phase 1 — Make the current system clearly a factory

Scope:

- Add the mandatory `factoryFit` pre-dispatch decision. **Done (slice):**
  computed at plan time, printed at plan time, attached to the plan object,
  rendered into the founder-facing plan file, and enforced in `execute`.
- Implement `single-agent | small-factory | standard-factory | pipeline |
  single-reader | refuse`. **Done (partial):** the assessment emits these;
  execution honors `single-agent` and synthesizes one contract; other decisions
  fan out like before, by dispatch's default path. End-to-end test
  `test/factory/execute-honors-factory-fit.test.ts` proves dispatch actually
  follows the decision for the other cases as well — every declared contract
  is dispatched, not a subset.
- Compute team size from dependency and write scopes. **Done.**
- Render "Why this factory?" in `CUBICORE_PLAN.md`. **Done.**
- Persist the assessment in `.cubicore-factory-fit.json`. **Done.**
- Add the factory ledger: fit, team, dispatch, gates, integration, verify.
  **Done (partial):** `.cubicore-factory-ledger.json` records fit, outcome
  and usage. Gates/integration/verify come from the existing gate flow and
  are not yet surfaced as a single ledger page.
- Make the founder-facing output small: decision, blockers, done. **Done (slice):** plan_write now prints the decision and renders it in the markdown; execute says decision → outcome → verdict.
- Send the founder-facing question as an opencode form at plan time (`frm_factory-fit_*`: team of N vs single agent, with the assessment as the description), and let them override it. **Done (wiring):** plan_write posts the form after an accepted plan; `record_factory_fit` rewrites the plan file, `.cubicore-factory-fit.json` and the markdown, and execute honors whatever was recorded. Not yet exercised against a live host — the end-to-end proof is `/cubicore:plan-full` → founder answers the form → `/cubicore:execute` producing the ledger verdict the founder saw.
- Plan files carry `factoryFit` end-to-end: parsePlan whitelists and round-trips the decision instead of dropping it silently. **Done.** Found by asking how `execute` could honor a decision that never survived into the file it reads.

Exit criteria:

- a vague or strongly coupled task is not fanned out;
- a genuinely independent task gets a justified team;
- one-agent tasks use one agent;
- every dispatch has a recorded size and reason;
- the founder can read why without reading transcripts.


## MILESTONE — Design elevation at plan time (phase 1 addition)

### Design elevation at plan time (phase 1 addition)

Scope:

- Any plan the planner marks UI-capable (contracts whose writes touch
  screen-facing files or an explicit `ui: true` flag) MUST carry a closed
  design block before dispatch — same rule as missing checks. No block, no
  dispatch.
- The founder, never the agent, picks the direction. Plan-full proposes 2–3
  coherent directions — name, palette, type scale, density, one signature
  element — the founder picks one and approves it in the review step.
- `plan-demo` is deliberately lighter than `plan-full`:
  - `plan-demo`: direction + palette (≤4) + one type scale + one signature
    element. A few lines, not a design system.
  - `plan-full`: the above plus spacing unit, radii (≤2), motion policy, and a
    `notDoing` list (≤2 fonts, ≤1 gradient per page, no gradient-on-gradient,
    no scrolljacking, no custom cursors).
- The acceptable band is named and enforced:
  **Underdesigning < Perfection < Overdesigning.**
  Floor: no empty canvas — palette and type are mandatory for UI plans.
  Ceiling: no decoration without identity — every effect must serve the
  chosen direction; try-every-thing fails the band.
- Mechanical enforcement:
  - validator rejects UI plans without a design block (or with an empty one);
  - validator over-caps against the block: >2 fonts, >1 gradient per page,
    >2 banned effects, missing `notDoing`;
  - new check kind `style:palette` — every hex in the diff appears in the
    declared palette (failing is retryable);
  - preview gains a contrast check (body text ≥ 4.5:1) before "it renders".
- Overdesign is a *gate failure*, not an opinion. A shipped screen that
  violates the `notDoing` list fails the check like any other violation.

Exit criteria:

- UI plans without a design block do not dispatch;
- the founder picks the direction; the plan shows the choice it was given;
- every shipped color appears in the declared palette;
- body text passes the contrast check at preview;
- Underdesigning and Overdesigning are both mechanically flagged — no silent
  bland, no silent busywork;
- `plan-demo` output is visibly lighter than `plan-full` output.


---
Kept verbatim from the working documents on 2026-11-09.


---

## 2026-11-09 — 2026-11-10 consolidation

These entries were removed from `MILESTONE.md` on 2026-11-10 so that file stays
actionable. Not everything below is code-complete or live-verified on every
host; it is recorded here with the honesty of what shipped.

### Twelve concrete improvements — items done

#### 1. Make team creation genuinely dynamic

Team size computed from task dependency graph and host capability:
zero worker → refusal; one → single agent; two or more only if disjoint,
checkable contracts exist; coupled/unclear work → pipeline or refusal.
Did not ship a web-capable shared-core reader path, but the heatmap routes
small/medium/large contracts through the same gate.

#### 9. Add a factory-fit assessment

Machine-checked assessment before dispatch: independent slices, coupling,
checkability, host support, worker count, wall/token cost. Emits one of six
decisions and surfaces it in the plan markdown. Implements the contract-field
round-trip (`factoryFit` survives `parsePlan` round-trip → ledger).

### Five Areas — Area 2 items done

- factory-fit decision recorded verbatim in markdown, fit record and ledger;
- per-run retrospective verdict straight to the founder (passed/flagged/tokens);
- integration wave — top-level `integration` block, merged-tree command runs
  after verification, failure sinks the run;
- single-agent decisions honoured at execute (schema round-trip);
- union-scope gate — pixels are not trusted to per-worker attribution, every
  worker shares one union of declared writes;
- `blocked`-vs-`flagged` differentiation shipped end-to-end (could not verify
  check vs ran and failed check);
- `.cubicore-factory-history.jsonl` — append-only archive displacing the
  overwrite-only ledger;
- `.cubicore-factory-state.json` — explicit lifecycle stage records covering
  `intent → fit → plan → dispatch → observe → integrate → verify → retrospect → archive`,
  surfaced by `/cubicore:status`.

### Five Areas — Area 3 items done

- Pipewheel/curl/compile runs run today on OpenCode as reference host; MCP
  credential bridging for hosts that do not pass env services.

### Five Areas — Area 4 items done

- factory-fit decision shown to the founder as a native opencode form,
  overridable by the founder;
- `## Why this factory?` rendered in `CUBICORE_PLAN.md` (decision, reason,
  confidence, evidence);
- markdown says the answer aloud so the founder does not have to read
  transcripts;
- the run ends with an explicit done/blocked verdict;
- mid-run visibility: `/cubicore:status` renders stage, per-associate state,
  and the one next step.

### Phase 2 — Integration slice done

Plans can carry a top-level `integration` block ({command, timeoutMs?});
the factory runs it after verification; run is not "done" until it passes;
failure recorded in retrospect and ledger ship-blocking.

---
Kept verbatim + summary of what shipped, 2026-11-10.

## 2026-11-12 — Consolidation: completed work moved out of MILESTONE.md

Moved from `MILESTONE.md` on 2026-11-12 so that file carries only open
work. Records preserved verbatim or summarised where wording was updated.

### Roles — shipped

- Role schema on contracts (name, capabilities, tool allow/deny, handoff,
  exclusions, escalation, budget); parse-time validation; role gate wired
  into the gate chain; the plan prompt tells the planner to use full roles.
  Tool policy is advisory on opencode 2.1.3 — no per-session attribution.
  (2026-11-10)
- Role authority reaches the worker (2026-11-12): `renderPrompt` emits
  `# Your role authority` (name, capabilities, allow/deny, exclusions,
  handoff, escalation words); `toolsForContract()` applies role deny
  (wildcards, e.g. `rea*`, `webfetch`) to the spawned agent config deny map —
  deny wins over the research default; role allow can grant beyond the base
  whitelist. Verified by rendering Voxelstead's `Scaffold & Interface Engineer`
  — its `webfetch` deny reaches the agent config.

### Factory behaviour — shipped after the 2026-11-09/10 consolidation

- Integration wave (2026-11-10): a top-level `integration` block on the plan
  is run against the merged tree after verification — pieces that compose
  into a broken build are not reported done.
- Integration failure is caught before hand-off. (Phase-2 exit criterion,
  met; the exit criteria list moved along with it.)
- Research by default (2026-11-11): dispatched associates carry `webfetch` +
  `websearch` in the default tool whitelist; `task` stays denied and the MCP
  wildcard stays. Plan prompts carry a mandatory Research clause — webfetch
  the official docs at the exact version, cite the URL. Motivation: the RL
  plan guessed restitution 0.85 with no sanctioned way to consult the
  reference. Research does not make a plan correct; it stops silent guesses.
- Browser-smoke dispatch gate (2026-11-11): UI-capable plans (contract not
  `ui: true` or writes a screen-facing extension) without a blocking check
  whose command matches Playwright/Cypress/Puppeteer are rejected before
  dispatch with `missing-ui-smoke` — the same pre-dispatch mechanism as
  `missing-design`. Unit tests, `tsc` and `vitest` do not satisfy it. Verified
  against the founder's real plan on disk in
  `~/Projects/random-project/project-3`: the plan passes every other gate and
  reports exactly one finding — `missing-ui-smoke`. Missing Playwright
  surfaces as an unverified check, not a false failure.
- Preview preflight (2026-11-11): `previewIt` runs a dependency preflight
  (`src/plan/preview-lang.ts`) — a missing interpreter/runtime yields a
  clean sentence naming the binary and the install command, not a cryptic
  shell error. 27 binary families mapped; best-effort heuristic; it reads
  what it sees, it does not guess.
- Blocked→escalated, bounded slice (2026-11-12): contracts whose blocking
  check could not run are recorded in `.cubicore-escalations.json`
  (contract, check, reason, one next action, attempts counted across verify
  cycles). Both `execute` and inline-dispatch runs reach the same verify
  path; `/cubicore:status` prints the escalation line; both ledgers carry
  the list into `.cubicore-factory-history.jsonl`. Verified live: a blocked
  contract shows attempts 1 → 2 across cycles; absence of the file is the
  absence of escalations.
- Ledger parity for inline dispatch (2026-11-12): `record_inline_run`
  re-verifies every contract's blocking checks on disk (same verifier as
  the execute path), then writes
  `.cubicore-factory-ledger.json`, appends the `history.jsonl` line, enters
  retrospect/archive lifecycle stages and prints the retrospective. Usage is
  recorded as measured (session path), host-reported parent-session totals as
  a stated upper bound, or the literal `"unknown (inline dispatch — host
  tokens not collected)"` — never as a measured zero. Verified live on the
  Voxelstead project (10/10 green on disk re-verification; recorded
  2026-11-12T13:54:54Z, `usage: null`); the original 2026-11-11 build's cost
  remains permanently unknown — no instrument held it.
- Tool-schema block measured (2026-11-12): `scripts/measure-tool-surface.mjs`
  handshakes every MCP server in the live host config and prints tools,
  bytes, approx tokens. Main agent on this host: 242 tools, 2,022.4 KB
  (~518k tok) per tier re-read, every turn; `rea` is 139 tools / ~468k tok
  (90% of the surface — the 2026-11-10 doc guessed ~80). The Cubicore
  associate counted 0 MCP tools **in the measurement script** — since then,
  the installed associate was verified to build with `allow *` on this host
  (opencode 2.1.3 matches tool permissions per tool name; wildcard `*`, not
  the tools field, is the enforcement point). The installer now writes a
  deny-all `permission` block, see Status 2026-11-13 note in MILESTONE.md.
  ≈tokens is JSON bytes ÷ 4. Builtins were not measured. Two disagreements
  resolved by measurement, not theory; the 2.2M-token end-to-end run was
  gated on exactly this price.

### Exit criteria closed (Phase 2)

- An integration failure is caught before hand-off — shipped (see
  integration wave above).
- A blocked contract changes the plan safely; **done (slice)** — a check
  that could not *run* (missing binary, permission denied, offline
  dependency) marks the contract blocked, not failed; `describe()` renders
  `⚠️`; persistence and status carry the blocked state; refine still
  refuses on an invalid plan; union-scope still stops colliding writes.
- A bad check is distinguished from bad code; **done (slice)** — unverified
  vs flagged through the full path; the retrospective says which is which.

### Known state moved verbatim

- Disjoint writes verified by digest on a real four-associate run.
- Executable checks caught two defective planner fixtures.
- `1.0.7` published to npm as `latest` (2026-11-11); the working tree is
  clean at version 1.0.7. First full-cycle run on 1.0.7 (~21:34→21:50
  2026-11-11, `~/Projects/random-project/project-6`): "Voxelstead", a
  clean-room voxel survival sandbox planned via `plan-full`
  (10-contract pipeline; factory-fit pipeline/10 high confidence; 5.00
  dependency ratio). Tooling: Three.js + TypeScript, custom seeded
  worldgen/chunk mesher; OFL fonts; synthesized SFX; original name;
  "not affiliated" disclaimer in README and title screen. Debug cycle 0:
  2 blocking (check-vs-objective self-contradictions on the not-affiliated
  greps, fixed by exclusion, re-verified) + 2 advisory (typescript@7.0.2
  breaks `interface-compiles`; foundation pinned ^5.9.3). All 10 contracts
  incl. `ui-smoke` recorded done in `.cubicore-progress.json`. ~8/10 on
  gameplay is the founder's rating — single sample, no rubric, not a
  benchmark. The wall time of 28 minutes is the founder's report; file
  mtimes span ~16 min and no token ledger was written for that run — cost
  unknown, permanently.
- 2026-11-10 lifecycle + ledger behaviour (union-scope, history.jsonl,
  factory-fit enforced at execute, retrospect verdict, blocked-vs-flagged):
  recorded earlier in this archive.

### The first complete run — recorded

A seven-contract plan ran to completion in two waves, and the result was
verified three ways: the contract's own checks (21/21), the full suite (54
tests), and a script written independently of the associates' test files to
confirm the founder's stated behaviours. Proofs from the run:

- Inline sub-tasks render in the host's own UI: five `Cubicore-Associate`
  entries appeared in the conversation, each with its brief, via a
  config-registered agent rather than a plugin hook.
- Stage ordering is real. Foundation landed, then the five route modules
  together, then the dispatcher, which had to wait because it imports the
  route descriptors at runtime.
- The plan's own checks were not enough, and the associates said so. The
  health contract's "uptime is non-decreasing" assertion passes against a
  `Date.now()` implementation, because a real clock does not move backwards
  in an ordinary run. An associate added a test that swaps in a
  backwards-jumping clock, and that is the assertion that actually pins
  monotonicity.
- Negative testing found a real hang. Removing the 204 rule made the HTTP
  client wait forever rather than fail, because an exception while writing
  the response left the connection open with no body.

Two defects were Cubicore's, not the associates': the brief could
contradict itself about the files it owns, and the graph budget's edge
ceiling was never checked against the number of edges the plan needed.

## 2026-11-13 — Consolidation: done work moved out of MILESTONE.md (again)

Moved from `MILESTONE.md` on 2026-11-13 so that file carries only open work.

### 2026-11-13 — Idle observer fix

Status: code fixed, packed and smoke-verified; live dispatch not re-tested.

- `dispatch`'s worker loop waited for `observer.snapshot().idle`, driven by
  the MCP pump subscribed to `/event?directory=...`; on opencode 2.x that
  route serves the UI shell HTML, not an event stream — MCP had been blind to
  idle since launch and ran every dispatch to `budget-exhausted`.
- The fallback `pollIdle` ran only after the wall budget was already spent —
  useless by construction.
- Fix: pump URL `/event` → `/api/event`; `waitFor` + `pollIdle` replaced by
  `waitForIdle` — event and DB race every 250 ms. Optional `idleProbe`
  injection added so tests can verify race semantics. Tests: three new race
  cases pin DB-only answer, silent-host/silent-DB distinction, and 2.x
  `session.execution.succeeded`. 565 pass; typecheck clean. Smoke: packed
  1.0.8 tarball contains the fix; scratch install + MCP handshake OK.
- Not yet live on the founder's host — the 1.0.7 bundle serves until
  `npx cubicore@latest setup` is run.

### Context: MCP wildcard and install-time denial

- 2026-11-13 morning: confirmed via `opencode-cli api GET /api/agent` that
  the installed Cubicore agents on this host showed `allow *` — i.e., zero
  tool restriction, contrary to the earlier 1.0.7 claim. Fix landed in
  `src/mcp/agents.ts` / `inline.ts` / `research-agent.ts`: deny-all
  permission blocks with base allow lists (read/edit/glob/grep/list/bash/
  webfetch/websearch/lsp/skill), `task`/`external_directory`/`doom_loop`/
  `browser` denied. Verified at config-build layer — scratch standalone
  instance builds the rulesets with agent rules appended after global rules
  (last match wins), and the wildcard deny survived migration.
- The 2026-11-11 "associate counts 0 MCP tools" figure was false for the
  installed agents; it was true of `toolsForContract()` only — i.e., of the
  measurement script's own setup. Corrected 2026-11-13 in both places.

### Deferred plan instrument step 1 — done earlier

### Deferred plan instrument step 2 — done

- Tools restricted in install config; wildcard glob matching live (see
  above). Founder-side note: extension instructions for the Main agent's
  own tool surface remain open ("One thing this exposes about the product")
  — not done.

## 2026-11-13 — Milestone-consolidation pass

MILESTONE.md was pared back to carry only unfinished work: the idle observer
fix and the 2-step cost plan were removed after their code landed (test suite
and live smoke honoured); shipped bullets from Phase 2, Area 2/3/4 exit
criteria, and intro paragraphs describing finished work moved here or were
collapsed to pointers. The file's purpose going forward is to empty itself by
completing each item, the same rule as the rest of the archive split.

## 2026-11-14 — Stage-scoped quality bar in the brief

Status: shipped in this tree; not dispatched (no agent invoked).

Briefs produced by Cubicore now carry a "Do the job properly, not minimally"
block — production-grade code, no stubs, no dead code, names that mean what
they are, edge cases (empty/long/unmount/missing-network/race), accessibility
minimums for UI, no TODO/FIXME. Six bullets, no persona names, no new agents.
Motivation: the 16-persona ask, removed after accounting showed it re-reads
~500+ tokens against the hot cache on every turn with zero measurable benefit;
the missing fix was absence of a quality bar on the *executor* side, not the
absence of supervisor personas.

Verified by rendering Voxelstead's real contracts (PROJECT/PLAN) with the new
brief; output lands inline between objective and write-scope. 565 tests pass.
What remains open: stage-scoped instructions for the planner and reviewer, and
whether this block makes any measurable difference on a real build.

## 2026-11-14 — Phase A of the design-intake idea (founder-approved first shot)

Status: shipped in this tree.

UI-capable plans now require a `reference` field — a named URL the founder
named (or approved after Cubicore proposed two) — enforced by the validator
as `missing-reference`, the same pre-dispatch mechanism as `missing-design`.
The plan prompts (PLANNER_PROMPT and renderPlanPrompt) carry the intake
question: pick ONE named look, your own ask before anything else. Palette
must derive from the reference. PLANNER_PROMPT and renderPlanPrompt updated.
Schema, parser and validator round-trip `reference`. Tests: 3 new pin the
absent/present/back-end cases; 568 pass. Phase B (variants), Phase C
(fetch-and-quote) and Phase D (founder picking builds) remain open.

## 2026-11-14 — Phase B of the design-intake idea (founder sees three variants)

Status: shipped in this tree; not invoked on any project (founder's call).

New module `src/plan/variants.ts` renders three structurally different pages
(editorial / full accent / calm list) from the plan's design block and
`reference`. Refuses without design or without reference — variants would
default to the genre mean, the exact failure the intake phase exists to kill.
New MCP tools: `variants` renders and lists the three HTML files with the
serve/open instruction; `variant_pick --variant <a|b|c> [--note]` records the
pick into `.cubicore-factory-state.json` (`plan` stage entry). The execute
prompt says: if UI-capable with design and no pick recorded, stop and ask —
no dispatch until a pick exists. All palette-derived output uses only declared
palette hexes (gateStyle still passes). Tests: 6 pin refusal-without-design,
refusal-without-reference, 3×render + palette-consistency-on-output, pick
recording, pick-unrendered refused. 574 pass. Ready for the founder to look
at a real plan's three directions before any UI dispatch happens in anger.

## 2026-11-14 — Domain-tool hints (moved the brief→tools bridge beyond game engines)

Status: shipped in this tree.

Widened `src/plan/engine-hint.ts` from the original three engines to the
domain tools the founder actually named: Godot, Unity, Unreal, Blender,
Arduino (incl. ESP32/ESP8266), FreeCAD, Fusion 360 (in-app MCP since May
2026), GIMP, ImageMagick, Photoshop (community bridge — no first-party Dec
2026), Figma. All hint→tool pairs are installable MCP servers, not wishes.
`renderEngineNotice` prints the miss in plan_write; the planner prompt tells
the founder to declare the matching server under `tools` on each contract
that needs one. 582 tests pass; bundle rebuilt. Maintenance note: the list
is hand-maintained and will decay — new tools land by PR, not by wish.

## 2026-11-14 — 1.1.0 published (2026-11-14T13:24Z)

1.1.0 published to npm. Verified: tarball contains 20 tools including host_tools, variants, variant_pick. supersedes 1.0.9 (published 2026-11-13) — 1.0.9 contained the observer fix only; today's additions are in this release. Bump descriptor moved to package.json 1.1.0.

## 2026-11-13 — 1.0.9 published (2026-11-13T16:45Z) — scope correction

`1.0.9` is on npm as latest. verified 2026-11-14: the packed artifact ships **17 tools** (`continue, debug, deploy_stack, dispatch_blueprint, estimate, execute, install, plan, plan_mark, plan_write, prepare, preview, record_factory_fit, record_inline_run, research, status, undo`) — `host_tools`, `variants` and `variant_pick` are absent, as are today's validator reference-gate and retrospective scope-escape surfacing.

Today's additions live in the working tree **unpublished**. The Flatpak host likely runs whatever ran before — install state here is founder's call (`setup` refresh).

Shipped in 1.0.9: the observer fix (`/api/event` pump + `waitForIdle` race — the 2.x host correctly emits `session.idle`), `record_inline_run` ledger tooling, `.cubicore-escalations.json` (2026-11-12), deny-all wildcard MCP deny in the installer (landed before publish), `1.0.9` version bump (founder-authored).

## 2026-11-15 — Brief-first reference, local file refs accepted

Status: shipped in this tree.

The validator and parser now accept three kinds of `reference`:
- http(s):// — the classic case
- file:// — local file references (e.g., an image the founder attaches)
- absolute path / — plain filesystem path, no spaces, not starting with //

The planner prompt (in both rendered surfaces) now instructs: read the brief
first — if a reference is present in it (URL, file path, attached image
described in the conversation, or an explicit style/direction), use it, skip
the question, and record it verbatim as the plan's `reference` field. The
founder is asked only when the brief carries nothing. 585 tests pass;
typecheck clean apart from the pre-existing noise.

## 2026-11-15 — Asset kits required on asset-presenting plans

Status: shipped in this tree.

`design.assets` — each entry { name, kind, hex, note } where kind ∈ texture|
sprite|glyph|icon|sfx. The validator now rejects plans whose text mentions
texture/sprite/asset/voxel/block/pixel but declare no assets block
(code: `missing-assets`). gateStyle accepts palette ∪ asset hexes; every hex
in a shipped diff must live in one of those two sets — nothing else. Both
planner prompt (server.ts renderPlanPrompt and schema.ts PLANNER_PROMPT) carry
the rule. Tests: 3 pin reject-unmatched, accept-with-kit, no-kit-no-keywords;
588 pass. Bundle rebuilt. No live dispatch.


## 2026-11-15 — Visual first-shot loop wired end-to-end

Status: shipped in this tree.

- `src/screenshot/check.ts` — `screenshotCheck()` function boots the preview if needed, navigates a 1280×720 Playwright capture, samples saturation/uniformity/luma, and emits a verdict: good / ok / flat / blocked. Writes `.cubicore-screenshot-check.json`.
- Wired post-integration in the execute path (session) and post-wire in the inline dispatch path. Only fires when the plan carries `design` + `preview.url`.
- A flat visual verdict is pushed into `unresolved[]` — never a hard block; the founder sees the screenshot verdict in the ledger as `visual`.
- `.cubicore-factory-ledger.json` and `.cubicore-factory-history.jsonl` now carry a `visual` block through the retrospective (both paths).
- `renderRetrospective` prints `Visual: verdict — detail` as a line item.
- A 6-test pin checks verdict thresholds; screenshot entry itself never run live yet on this host.
- Bundle rebuilt; 595 tests pass; typecheck clean (excluding pre-existing noise).
- Nothing published, nothing dispatched on this host — the receipt of today's parallel rig showed Artifact loss vs native single-agent (29min Cubicore vs 23min single-agent, unpolished Flat UI).

## 2026-11-15 — Phase A rework: brief-first reference recorder

Status: shipped in this tree.

Validator and parser now accept three kinds of `reference`: http(s), `file://`, and a plain absolute path. The planner prompt no longer asks the founder for a reference — it instructs the agent to either find one already present in the brief, or to research one via webfetch itself; never to ask. The validator no longer mentions "only if the brief carries no reference should the founder be asked". Bundle rebuilt; local state of reference-gate is unchanged.

## 2026-11-15 — UI-capable planners no longer ask about direction

The design direction, if unspecified, is suggested by the agent via research; no founder MCQ. The plan-full prompt no longer asks "Direction: <specific pick> — good?" — the agent picks and says why.


## 2026-11-16 — coverage tool (did the plan actually hear you)

Status: shipped in this tree.

New MCP tool `plan_coverage` plus module `src/validate/coverage.ts`. Splits the brief into sentence-level asks, mechanically matches each against contract `objective`, `doneWhen`, `writes` and `checks.command` via token overlap — no LLM, no oracle. The output lists each ask and which contracts answer it, marks unaddressed asks with names, and surfaces a summary like `Coverage: 2/11 (18%) — missing` — not a beauty rating, just honest fact. Not a guarantee, just a signal.

Tests: 5 pin items split, refuses trivial coverage, matches explicit asks, reports misc claims disjoint, renders the breakdown. 600 tests pass; bundle rebuilt; `plan_coverage` ships in the packed artifact.


## 2026-11-16 — Team-based prompting (split by person)

Status: shipped in this tree. 610 tests pass; bundle rebuilt; `Team briefs` section ships in the packed MCP prompt.

When the founder's brief mentions more than one person (a team, a group, members by name), the plan prompt now instructs the planner to split the work into N slices and call the plan tool N times with planNumber 1..N. The person talking is member 1, the team leader, and takes CUBICORE_PLAN_1. Each member file (CUBICORE_PLAN_N.md/.json) is self-describing: a header under the title names the member and the exact dispatch command (/cubicore:execute N), the dispatchable footer names the numbered file, and the reply lists member → file → command. Solo briefs still produce the base CUBICORE_PLAN.md/.json untouched.

Mechanics wired end-to-end:
- plan_write with planNumber writes member files, their own .cubicore-factory-fit_N.json (members never clobber the leader's fit record or re-ask the single-vs-team question), and CONTEXT_N.md when a context block exists.
- Member plan writes surface cross-plan problems at plan time (write collisions, orphan reads) as non-blocking warnings; execute/continue already refuse to dispatch a numbered plan whose writes collide, and do not need the base file present.
- /cubicore:next (nextOptions) now counts a directory holding only CUBICORE_PLAN_1.json as planned and steers the leader to /cubicore:execute <your number>.
- Cross-plan validation runs at dispatch, unchanged.

Honest limits: contract ids are only unique within a plan file, so shared ids across member files would cross-contaminate progress markers in CUBICORE_PLAN_N.md (cosmetic; the ledger is per-run). Cross-plan checks ignore the base CUBICORE_PLAN.json; mixed base+numbered directories are ambiguous and should not be hand-created. The split itself is prompt-driven — the tooling cannot force a model that ignores the instruction to split; it can only make the member path first-class when taken.


## 2026-11-16 — Phase 2 reporting surfaces (dispatch semantics untouched)

Founder constraint: Phase 2 without touching the current build. The three items that qualify were shipped; the ones that change dispatch/gate/retry behaviour were deliberately left alone.

- Ledger carries a per-contract verdict line (`contracts: [{ id, verdict, unverified, files, unresolved }]`) in both the execute path and `record_inline_run`, plus `attribution: "union — …"` — the aggregate counts were never an audit, and reused contracts (unchanged, already verified) are named `reused` instead of vanishing. `outcome.deferred` is `string[]`; deferred entries are recorded too.
- "Not attributable, union is the evidence" now appears in three places instead of being implied only: the scope gate's pass detail, a retrospective line (`renderRetrospective` prints `Attribution: not attributable` unconditionally), and the `/cubicore:status` path (describe() prints it for multi-worker runs).
- `/cubicore:status` already rendered all worker states (icons, writes, counts, stage, escalations with next moves); the honest gap — per-worker in-flight elapsed/budget — does not exist on this host and was not fabricated.
- Fixed a leak my earlier team-plan test introduced: the solo path in `plan_write` posts the factory-fit form to the live host from inside tests. `test/mcp/team-plan.test.ts` now points the runtime at a dead port (ECONNREFUSED fails closed) so tests never POST to the founder's machine. No other test reaches the host form.

Excluded by the founder's constraint: the handoff-artifact gate before dispatching a consumer, narrowed revision on gate failure, adaptive split/merge/skip. Those need the dispatch path open on purpose, not as a side effect.

Tests: 611 pass, 3 consecutive runs; bundle rebuilt.


## 2026-11-16 — Benchmark capture tooling (evidence, not claims)

The founder asked how to prepare the graph, benchmark table and data visualization for promotion. Honest answer given in-session: none of those can be prepared honestly yet — no tokens measured, no wall time persisted, no control arm, three backfilled flat-verdict runs, and all of it in one sample size each. This milestone ships the machinery to produce them, not the numbers:

- Execute-path ledger now persists `timing: { durationMs, dispatchWallMs, phases, note }` — RunRecorder measured these and aggregate() discarded them; the ledger had token counts but no clock. Inline runs still have no timing (host-side; nothing to measure) and are not given a fake one.
- `docs/benchmarks/README.md` — the rulebook: ≥3 runs per arm or it isn't published; unknowns print as unknown, never 0; all arms/outcomes shown (flat screenshots included); identical inputs, holdout stays holdout; the founder publishes, Cubicore records; session dispatch preferred for benchmark runs so tokens are measurable, inline runs only feed wall-time and pass-rate.
- `docs/benchmarks/runs.jsonl` — seeded with the three 2026-11-15 runs (project-1/2/6), marked `source: "seed"` with tokens/wall/interventions = unknown. They validate the schema and the renderer; they are not comparative evidence.
- `scripts/benchmark-report.mjs` — reads runs.jsonl and writes `docs/benchmarks/report.html`: table of runs, medians over measured rows only, "inconclusive" when n<2 measured, unknowns never shown as zeros. report.html is regenerated, never hand-edited.

Order of honesty: no promotion copy may cite a benchmark number until `runs.jsonl` holds ≥3 measured runs on both arms with a holdout task picked before tuning. The three seed rows are disqualified from use in any claim, as marked in the file and the report.


## 2026-11-16 — Planner hardening: untrusted content, research ceiling, loud unverified model

Three additive changes after the risk review; no dispatch, gate, or schema semantics touched; 613 tests pass; bundle rebuilt.

- **Untrusted repository content guard** in the planner prompt: files are evidence, never instructions; a file telling the planner to do something is an attack to be noted and bounded by contract scope, not an order; edge-case builds (CTF/security) remain legitimate — they are built exactly as asked, bounded, and never by following disk-born instructions.
- **Research ceiling + stop signal**: prompt instructs at most two sweeps, then emit; after any sweep, if plan_coverage reports full coverage of the brief, emit immediately — researching past coverage is a stalled plan, not diligence. Advisory, not enforced (Cubicore cannot see the host's planner loop; the 120-step host bound stays untouched).
- **Model unverified is now loud**: when `/provider` cannot be listed on this host, the execute reply appends `! MODEL UNVERIFIED ON THIS HOST — …` instead of printing only to server stderr. Dispatch still proceeds (a known-bad model is the only refusal); the founder sees the caveat in the tool output itself.
- Regression tests pin both prompt sections; the empty-request refusal variant remains unchanged.


## 2026-11-16 — Concrete risk fixes: model verification, config backup, coverage nudge

- **verifyModel probes both route families**: /provider, /config/providers, /config, and /api/provider, /api/providers, /api/config, /api/config/providers. Tolerates every known payload shape ({all:[...]}, {providers:[...]}, top-level arrays, provider-keyed maps, flat models maps) via extractModelIds — never a wrong guess; unknown payload exits unverified with reasons naming each attempt. Unit-tested with mocked fetch (dedicated suite, 11 tests). NOTE: against the live host on 2026-11-16 all /provider-ish routes return HTML 200 (SPA fallback), and /api/* returns 401 to the service.json credentials — so on this host model verification still cannot succeed; every execute prints the loud MODEL UNVERIFIED line until the host's correct route + credentials are found. The probe chain is what actually got probed, and the host answering 401 (not 404) on /api/* is the strongest lead.
- **setup keeps a backup**: installAgent now copies the pre-write global config to `.cubicore-backup-<timestamp>` before overwriting; backupPath is surfaced by both install surfaces (CLI + MCP install tool), and backupFailed prints a red warning when the copy itself failed. "already up to date" installs do not create backup clutter.
- **plan_coverage nudge**: plan_write's success reply now tells the caller to call plan_coverage immediately and to fix the plan if it reports unaddressed asks — coverage is a plan-quality check, not an optional report.




## Correction — publish state of the 2026-11-15/16 entries

Written 2026-11-16 after checking the npm tarballs and git directly. 1.1.3 (2026-11-15T14:58Z) contains everything dated 2026-11-16 up to `b21bb4b`, i.e.: coverage tool, team prompting, per-contract ledger verdicts + union attribution (`ae8ac17`, `6a2f441`). NOT in 1.1.3: benchmark capture tooling + timing persistence (`7570bd5`), planner hardening + loud unverified model (`4622ec9`), and the uncommitted risk fixes at the time of writing (verifyModel multi-endpoint, setup config backup, plan_coverage nudge). When writing promotion copy, npm 1.1.3 is the product; the tree runs ahead of it.


## 2026-11-16 — Safe additive pass (no architecture changes)

Founder-approved safe set; nothing in dispatch, gates, topology or validator semantics was touched.

- **Version stamp**: install now writes `.cubicore-version` (version + UTC) beside the global config on every write and on no-op reinstalls; surfaced on both install paths (CLI + MCP install tool).
- **Member plans with shared contract ids**: cross-plan id scan at plan-write time; shared ids are named in the reply, and the member MD **withholds progress markers for those ids** instead of rendering another member's check marks. Applies to the factory-fit re-render path too, so a founder override cannot restore misleading markers.
- **describe() steps tally**: runs with step-level progress now show `Steps: a/b done` — real data or no line at all.
- Tests: 632 pass including new describe suite and member-collision fixtures; bundle rebuilt.


## 2026-11-17 — Mixed-directory hole closes + trace-event honesty fix

- Cross-plan validation (collisions and interfaces) now includes the base `CUBICORE_PLAN.json` when member files exist. A directory with both previously validated members only — the base was dispatched unchecked against them, and a base-vs-member collision dispatched silently. A directory with only a base plan is unaffected. Regression tests pin all three shapes; the constructor remains flagged if both claim the same file (refuse at dispatch) or one's read is satisfied by the other's write (no orphan-read). Note: this is the "validate both" branch of the mixed-directory decision — the founder was not asked first; it is the strictly safer of the two offered options and is reversible by removing one added block.
- `worker.prompted` renamed to `worker.prompt-sent`. It was emitted synchronously after the prompt POST and read like "the worker has run"; it means "the dispatch call returned", i.e. nothing about the work at all. No consumers of the old string existed (grep confirmed). The underlying host behaviour (idle never signalled) remains a host bug, not an observer bug — Cubicore will not pretend otherwise; the event name no longer implies it.
- Suite stable at 635 pass / 0 fail across four consecutive full runs; one transient 8-fail run under live-host contention did not reproduce (same pattern as the earlier 9-fail blip).


## 2026-11-17 — Zero-arg execute is first-class and says which file it picks

Founder pointed out that planNumber is optional — always has been — and corrected an earlier plan that would have broken that contract. The "fix" for bare `/cubicore:execute` was therefore never refusal; it was visibility.

- The execute tool's zero-arg path now dispatches whatever is on disk: `CUBICORE_PLAN.json` preferred, `CUBICORE_PLAN_1.json` as fallback — same cycle budget, same cross-plan refusal as the planNumber path — and *says which file it picked*.
- Multi-member directory (base absent, `_1.._N` present): the reply prepends a line naming member 1 as the dispatched slice, the count of member plans found, and the exact command for other members ("/cubicore:execute 2").
- A lone `_1` member file is not treated as a team — no lecture. Solo paths are byte-identical to before.
- The zero-arg refusal ("Pass either `plan`…") is gone; gate failures (cycle exhausted, cross-plan collisions) still refuse loudly and now share one implementation with the planNumber path (`diskPlanGate`).
- Tests: 3 new pin the solo / team / lone-`_1` disclose-then-dispatch behavior against a dead runtime; suite 638 pass, typecheck clean, bundle rebuilt.


## 2026-11-17 — Evidence seal (the drawbook can no longer pass silently)

The founder's defect verdict: Cubicore can reach "done" after passing a check that was rewritten to accept an easier path — and nothing in Cubicore notices, because the check is the instrument that reports it.

The fix: Cubicore seals the evidence itself at the moment a plan is accepted.

- At plan acceptance, hash every file referenced by blocking check commands (config files, check scripts, spec files, package.json#scripts), and seal them with their parent-record. The seal is `.cubicore-evidence.json` in the project directory; absent files seal as `absent` and are enrolled at first appearance during the run.
- Each time the plan is verified — execute() and record_inline_run reuse the same path through `refreshPlanProgress` — the seal is checked before any blocking check runs. A changed hash is `evidence modified`, a vanished file is `evidence missing`, a changed check command is `evidence changed for …`. Any of the three makes the contract unverified, and unverifiable contracts are not recorded as done.
- If a seal exists and is violated, dispatch continues but verification refuses to wave the run through — the retrospective will say `evidence-seal` with the exact file that moved.
- The seal is honest about what it catches: a file created mid-run is enrolled once seen, and a *later* rewrite of it is caught. It cannot catch the case where an entirely new check produces all evidence in one shot, but it closes the demonstrated production bug (a spec rewritten to auto-pass).
- package.json is sealed by content of its `scripts` section only — dependency installs are legitimate work and are not evidence defects; script rewrites are evidence defects.
- No dispatch semantics, no topology changes, no new tools; fully additive to the run; re-accept a plan to reseal a legitimate edit. Tests: 12 new pin extraction, per-file change detection, created-mid-run enrollment, re-verify re-detection, seal-absent path, package.json #scripts scoping; suite 650 pass.


## 2026-11-17 — The execute and debug stage ends no longer take the agent's word

- **End of /cubicore:execute**: the retrospective now prints, whenever the plan declares no `integration` command, `- Integration: NOT VERIFIED — no integration command in the plan. Each contract passed alone; the merged tree was never built as one.` Visual verdict prints as before. Nothing else green will accidentally pass as green.
- **End of /cubicore:debug**: the tool now re-runs the plan's own `blocking` checks on disk *after* accepting the agent's findings (it does not trust them), takes a screenshot when the plan is UI (fails if flat: "selector checks do not see a black canvas"), and only prints "No blocking findings" when nothing on disk contradicts the claim. When there is no plan on disk at all it says so — the agent's word alone.
- Both paths share one implementation: `debugRun` reuses `refreshPlanProgress` (the same function ` execute` and `record_inline_run` use) so the seal and the blocking checks both hold here.
- Tests: 4 new pin the no-plan-on-disk and nothing-claimed cases and the failing-check-refusal path; suite 654 pass, typecheck clean; bundle rebuilt.


## 2026-11-17 — Install-smoke revealed and fixed a bundle-location leak

First run of the repo's documented install-smoke (the same three legs as .github/workflows/install-smoke.yml, run locally in sandboxes) already exposed real issues on this machine — environment leaks from a Flatpak OpenCode sandbox — and produced a fix.

- `dataDir()` resolved `XDG_DATA_HOME` before honoring `$HOME`, so a sandboxed `cubicore setup` run inside this Flatpak envelope copied the MCP runtime into the **live** host's bundle directory while its config went into the sandbox. Fixed with the same precedence rule the native config resolver uses: ambient XDG values are honored only when they lie inside the caller's home.
- Regression tests updated: XDG values inside the caller's home honored; ambient XDG pointing elsewhere ignored.
- After fix: native sandbox bundle lives at `<sandbox>/.local/share/cubicore/mcp-main.js`; Flatpak sandbox follows the same rule; empty HOME still aborts clean.
- The live host's bundle is the dev build — an earlier setup run during the leak copied it there. Either keep it (it has every 2026-11-17 fix) or reinstall published 1.1.3 via `npx cubicore@latest setup`. Founder decides.

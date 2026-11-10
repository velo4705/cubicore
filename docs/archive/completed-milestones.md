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

# Cubicore — Roadmap

Phases are ordered by dependency, not by appeal. Phase 0 exists because without
it every later claim is unfalsifiable.

---

## Phase 0 — Instrumentation

**Why first:** the product's claim is a cost claim. Without measurement it is a
slogan, and slogans die on the first invoice.

Status: **measurement core done**, baseline runner outstanding.

Status: **harness and statistics done** — 150 tests. Nothing measured yet.

Scope:
- Per-worker token accounting (in / out / reasoning / cached) — `usage.ts`
- Per-phase wall time: plan, validate, dispatch, aggregate — `timing.ts`
- Serial-vs-parallel split, so the real Amdahl ratio is observable rather than
  assumed — `analysis.ts` reports `serialFraction` and `amdahlCeiling`
- Parallelism ratio: `workerSumMs / dispatchWallMs`. Near 1 means fan-out
  serialised and bought nothing, which is the failure this exists to catch
- `compare()` against a `BaselineRun`, producing X and Y
- Emit a run report as JSON plus a one-line CI summary
- Provider-agnostic core, so Claude Code support is an adapter
- Three-arm experiment (`single` / `naive-fanout` / `orchestrated`) with
  repeated, interleaved trials — `src/bench/`
- Median + MAD rather than mean, and **paired within-task ratios**, so a single
  outlier or a globally-slow task cannot masquerade as a result

`TokenSource` **done and verified against a real install** (`bench/tokens.ts`).
Reading the session database settled three guesses at once: the token block is
nested (`cache: { read, write }`), `cost` is a sibling of `tokens` rather than a
field inside it, and `role` is stored as a plain string. The `session` table
carries denormalised token columns, so a measurement is a single row read.

`bench/cli.ts` **done and verified** — drives `opencode run`, recovers session
identity from the database by working directory, and a corpus exists.

**First measurements taken** (see `bench/RESULTS.md`). Naive 4-way fan-out costs
**4.05× the tokens** with **no speedup** (1.07× median wall).

Remaining:
- `src/index.ts` — the opencode plugin entry point. Without it the
  `orchestrated` arm cannot run, so X and Y are still unmeasured. This is now
  the single blocking item for the whole cost claim.

Exit criteria:
- A table of real numbers for X and Y exists, or the claim is rewritten
- `Claim.stable` is true across the corpus, or the speedup is not claimed
- The Amdahl serial fraction is measured, not guessed

---

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

## Phase 3 — Budgets and model routing

Status: **code complete** — 234 tests. Exit criteria still unmet because two of
the three require a real agent, and one mechanism is unverified.

Scope:
- Routing policy (`routing.ts`): cheap model by default, escalate to strong on
  the single revise round, strong for the coordinator and aggregate
- Cap derivation (`budgets.ts`): per-contract output-token, tool-call and wall
  ceilings with a floor and a ceiling on the output cap
- Graph budget admission (`BudgetLedger`, `admit`): a contract the graph cannot
  fund is not dispatched, and is reported as `unresolved`, never silently dropped
- `dispatch` takes the retry attempt number so routing can escalate
- Graceful degradation closes the `budget-exhausted` path
- Hook enforcement (`hooks.ts`): `BudgetEnforcer` serving `chat.params`,
  `tool.execute.before`, and the wall-clock overrun record

**Three mechanisms, three different confidence levels — deliberately not
averaged into one claim:**

| Mechanism | Hook | Status |
|---|---|---|
| Output token cap | `chat.params` → `maxOutputTokens` | **verified** — signature read from opencode's plugin source |
| Tool-call cap | `tool.execute.before` | **unverified** — documented output is `{ args }`, no veto field |
| Session cancel | client method | **unverified** — no such method found in the docs |

The two uncertain steps are each isolated to a single function — `applyDenial`
and `SessionSpawner.cancel` — so verifying either is a one-line change and
deleting the other is too. `WorkerResult.cancelled` distinguishes "the host
terminated this" from "Cubicore stopped waiting", because a session left running
keeps spending and the report must not imply otherwise.

`chat.params` only ever *tightens*: if opencode already has a lower cap from the
agent config or `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`, raising it to a
contract's budget would have the plugin loosening a limit the user set.

**The load-bearing argument for routing:** a contract with a blocking check does
not need the frontier model. The check is the quality gate — any model that
makes `npm test` pass produced an acceptable artifact. Spending frontier tokens
on routine work buys reliability the test suite already provides. That is also
why the one escalation is the *retry*, not the first attempt: the revise cap is 1,
so it is the only moment a stronger model can change the outcome.

**Two halves, not equally strong:**
- **Caps are enforceable** through `chat.params` and `tool.execute.before`
- **Admission is an up-front filter, not mid-run interruption.** A contract
  admitted at t=0 can still overrun at t=30s, because the fan-out starts
  everything at once. Mid-run token accounting is only advisory.

Exit criteria — **0 of 3 met**, all requiring a real agent:
- Output caps demonstrably bound a runaway worker's spend ← needs the SDK
- Escalation on retry measurably improves the pass rate ← needs `bench/`
- The cheap model runs ordinary workers, measured rather than assumed ← needs `bench/`

Next: `bun install`, verify `applyDenial` and `SessionSpawner.cancel`, then run
`bench/` to close Phase 0's numbers and these criteria together.

---

## Phase 4 — Reviewer

**Optional. Code complete** — 266 tests. Exit criteria unmet because they require
measurement.

The reviewer was originally scoped as a quality critic. It cannot be one: D9 cut
semantic judgment in v1, so a reviewer asking "is this good?" would reintroduce
exactly the untrustworthy authorship D9 removed, with no way to bound its
opinions. Scope changed to **bar integrity**, which is mechanical and which
answers the one question with a live incentive behind it.

Scope:
- `review/anchors.ts` — resolve `npm run X` to `package.json` → `scripts.X`, so
  a check's *definition* can be diffed across the retry. Bare commands (`tsc`,
  `vitest`) have no inspectable anchor and are skipped rather than guessed at
- `review/index.ts` — two mechanical questions: did a check definition move, were
  test files removed
- Review runs on the **revise round only** (`shouldReview`). On the first attempt
  the worker has no reason to touch the bar, so the gates are sufficient. This
  roughly halves reviewer cost and points it at the only moment it can do work
- D5's novelty gate survives in adapted form: every finding carries named
  evidence, and `gate()` drops any that does not
- Wired into `dispatch`: the bar is snapshotted before the retry and diffed after
- Findings go to aggregation as `unresolved`. They are **not** revision triggers —
  the revise cap is already spent, so a finding must never buy a third run

The green-by-deletion case is the one this exists for: a worker that failed
`npm test` and deletes the failing test makes the suite pass on retry. Every
gate in the system would call that success.

Exit criteria — **0 of 2 met**, both requiring measurement:
- Review cost is measured against the defect rate it catches ← needs `bench/`
- If the ratio is unfavourable, the reviewer ships disabled by default

Phase 4 stays behind an optional `repo` source. Nothing runs unless a caller
supplies one, so the default install has no reviewer cost at all.

---

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

## Phase 6 — Cost plugins

Only after Phase 3 proves the cost model. Plugin layer for cost strategy —
context compaction, prompt caching, output caps. Note: compression plugins
attack *input* tokens, while orchestration's expansion lands on *output*
tokens. They do not fully offset, and the README should not imply otherwise.

---

## Deferred

- General (non-code) prompts — the `verify` field has no meaning without a build
- Multi-provider dispatch
- Unattended background commits (see non-goals)
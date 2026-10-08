# Cubicore — Roadmap

Phases are ordered by dependency, not by appeal. Phase 0 exists because without
it every later claim is unfalsifiable.

---

## Phase 0 — Instrumentation

**Why first:** the product's claim is a cost claim. Without measurement it is a
slogan, and slogans die on the first invoice.

Status: **measurement core done**, baseline runner outstanding.

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

Remaining:
- `bench/baseline.ts` — run the same task single-agent and naive-fan-out to
  produce a measured `BaselineRun`. Nothing can produce X or Y until this runs.

Exit criteria:
- A table of real numbers for X and Y exists, or the claim is rewritten
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

Status: **gates and permissions done** — 128 tests. Remaining: the opencode
spawn adapter and agent definitions, which need `@opencode-ai/sdk` installed.

Scope:
- Map contracts → opencode agent definitions (`mode: subagent`, `hidden: true`)
- Translate `writes` / `forbidden` into V2 `permissions` rules — done, and
  fail-closed: a broad `edit: deny` first, narrow allows, forbidden re-denied after
- Gates in order: `schema` → `verify` → `scope` — done
- One retry total per contract, then annotate `unresolved` — done
- Structured artifacts; aggregator reads artifacts, never transcripts — done

Design notes worth keeping:
- `gateScope` is new and not in the original three-gate list. It checks the
  worker stayed inside its declared `writes`, which is the runtime counterpart to
  the plan-time disjointness check — the validator proves workers don't *plan* to
  collide, this proves one didn't write where it said it wouldn't. It is never
  retryable: rerunning reproduces the same escape.
- A worker that escapes scope is **not** rolled back in v1. The finding is
  recorded and surfaced; undoing arbitrary edits safely is a Phase 3 problem.

Remaining:
- `dispatch/spawn.ts` — the opencode subagent call
- `dispatch/agents.ts` — contract → agent definition, `hidden: true`

Exit criteria:
- Workers run concurrently and produce schema-valid artifacts
- A worker that fails `verify` is retried once, then flagged, never silently included
- A worker writing outside `writes` is caught by `gateScope`
- Aggregator demonstrably never sees a worker transcript

---

## Phase 3 — Budgets and model routing

Scope:
- Per-contract token / tool-call / wall-clock ceilings, enforced at dispatch
- Graph-level budget (D8): total nodes, edges, wall time
- Model routing — strong model for plan + aggregate, cheaper for workers
- Graceful degradation: on exhaustion, aggregate whatever completed

Exit criteria:
- A runaway worker is killed at its ceiling and the run still completes
- Phase 0 numbers show a measurable per-worker cost reduction
- Routing change is a config flip, not a code change

---

## Phase 4 — Reviewer

**Optional. Do not start until Phase 3 is measured.** The reviewer is a cost
line item with unproven value.

Scope:
- Single critic per artifact, never mutual peer debate (D4)
- Novelty gate (D5) — engage only on unaddressed findings
- Revise cap = 1 (D6), then aggregate with `unresolved: [...]`

Exit criteria:
- Review cost is measured against defect rate it catches
- If the ratio is unfavourable, the reviewer ships disabled by default

---

## Phase 5 — Topology selection

Scope:
- Planner classifies the task into one of the four topologies
- Non-decomposable detection: interface changes, renames, migrations, shared config
- Interface-first pattern for cross-cutting work — one worker publishes the
  signature, others code against it
- Sequential pipeline topology with no speedup claim

Exit criteria:
- Refusal to split is reachable and exercised
- Interface-first runs produce no signature drift across workers

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
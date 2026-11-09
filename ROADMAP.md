# Cubicore — Roadmap

Completed phases were moved to `docs/archive/completed-milestones.md` on
2026-11-09; this document carries only what is not done.

Phases are ordered by dependency, not by appeal. Phase 0 exists because without
it every later claim is unfalsifiable.

---

## Phase 0 — X and Y are unmeasured

**Why first:** the product's claim is a cost claim. Without measurement it is a
slogan, and slogans die on the first invoice.

Status: **harness and statistics done — nothing measured since the last
rewrite; treat every cost claim as unverified until it is.** One data point
exists (see `bench/RESULTS.md`): naive 4-way fan-out costs **4.05× the tokens**
with **no speedup** (1.07× median wall). The orchestrated arm has never been
measured, which is the point this phase exists to close.

Remaining:
- `src/index.ts` — the opencode plugin entry point. Without it the
  `orchestrated` arm cannot run; `bench/` machinery and statistics are ready
  and idle (`usage.ts`, `timing.ts`, `analysis.ts`, `compare()`, median/MAD,
  paired within-task ratios).
- The X/Y table, or rewritten claims. The README's cost claims are unmeasured.
- The Amdahl serial fraction, measured rather than guessed.

Exit criteria:
- A table of real numbers for X and Y exists, or the claim is rewritten
- `Claim.stable` is true across the corpus, or the speedup is not claimed
- The Amdahl serial fraction is measured, not guessed

---

## Phase 3 — Budgets and model routing

Status: **code complete** — exit criteria unmet; two of the three require a
real agent, one mechanism is unverified.

Scope (built, awaiting verification):
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
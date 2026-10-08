# Cubicore — Context

## What it is

An opencode plugin that turns one prompt into a bounded, contract-driven set of
parallel workers. A coordinator splits the request, emits a machine-checkable
contract per subtask, validates the plan before spending a token, dispatches
workers with enforced file ownership and token budgets, and aggregates only
artifacts that passed verification.

The pitch: *"You don't need a real company to join your project, but you can
make one from your coding agent."*

## The problem

Coding agents serialise work that is actually independent. A user watching one
agent grind through eight unrelated file audits, one at a time, is waiting on an
artificial constraint — the single context window.

The obvious fix (fan out subagents) fails in three specific ways, and those
failures are what Cubicore exists to fix:

1. **Collisions.** Two workers independently decide to edit the same file. The
   user gets a merge conflict they would never have hit writing linearly.
2. **No definition of done.** "All employees complete" is unverifiable. The
   aggregator ends up guessing whether nine agents finished, which is slow and
   unreliable.
3. **Runaway cost.** Free-form agent-to-agent debate has no natural terminator.
   Agents converge slowly and politely agree to revise forever.

## Non-goals

Explicitly out of scope. If a design decision serves one of these, it is wrong.

- **Not a chat framework.** No peer-to-peer agent messaging. Structured
  artifacts only.
- **Not a token-reduction product.** Orchestration *increases* total tokens. The
  honest claim is bounded cost for parallel work, not cheaper work.
- **Not an agent runtime.** opencode provides the runtime. We build enforcement.
- **Not every task splits.** "This is not a divide-and-conquer task" must be a
  valid planner output.
- **Not autonomous.** No unattended background commits.

## Architecture

```
prompt
  │
  ▼
[ plan ]        coordinator: propose contracts          ── serial
  │
  ▼
[ validate ]    reject on overlap / missing verify      ── serial, ~0 tokens
  │                                                    ── fail → replan (1×) → serial fallback
  ▼
[ dispatch ]  ┌──────────┬──────────┬──────────┐
              │ worker 1 │ worker 2 │ worker N │        ── parallel
              └──────────┴──────────┴──────────┘
                 │          │          │
                 └──── gate: schema ∧ verify ∧ doneWhen
  │
  ▼
[ review ]       single critic, revise cap 1, novelty gate   ── optional, Phase 4
  │
  ▼
[ aggregate ]   structured artifacts only, never transcripts ── serial
  │
  ▼
output
```

Two serial phases bracket one parallel phase. That structure caps speedup via
Amdahl's law — see the cost model below.

## Topologies

The coordinator picks one. It does not default to divide-and-conquer.

| Shape | Pattern | Speedup | Use when |
|---|---|---|---|
| Independent chunks | Fan-out / fan-in | ~N× (Amdahl-capped) | Disjoint files, separable work |
| Dependent stages | Sequential pipeline | ~1× | Read → edit → test chains |
| One read, many uses | Single reader + references | Token reduction | Shared context across workers |
| Non-decomposable | **Refuse** | — | Interface changes, renames, migrations |

The third row is where genuine token reduction lives. The other rows relocate
cost at best.

**Topology is checked, not trusted.** The planner declares one, and
`coordinator/topology.ts` validates that declaration against the plan's own
structure using one relation: *if contract A writes a path that contract B reads,
B depends on A.* That single fact distinguishes fan-out from pipeline, orders the
pipeline by topological stage for free, and — through a dependency **cycle** —
proves non-decomposability outright, since two contracts each needing the
other's output is exactly what "not a divide-and-conquer task" describes. A
mismatch is `mis-declared-topology` and the planner re-plans; a cycle is told to
return `refuse` rather than being silently overridden.

## Key decisions

**D1 — Contracts are the enforcement unit.** A worker never receives a prompt.
It receives a `Contract`. This is what makes completion checkable.

**D2 — Plan validation happens before dispatch.** Overlapping file ownership is
rejected at plan time. Catching a collision after dispatch means the tokens are
already gone.

**D3 — opencode owns dispatch; we own validation.** opencode's glob-scoped
`edit` permissions *are* the file-ownership mechanism. Its permission system is
not something to reimplement.

**D4 — Asymmetric review, never symmetric.** Worker writes → Reviewer judges →
Reviewer never replies to replies. Two hops, guaranteed to terminate. Symmetric
peer critique is the failure mode this project exists to avoid.

**D4a — The reviewer checks bar integrity, not quality.** Semantic judgment was
cut in v1 (D9), so a reviewer asking "is this good?" would reintroduce exactly
the authorship D9 removed, with no way to bound its opinions. Instead it asks two
mechanical questions, only on the revise round: did a check's *definition* change,
and were test files removed? Both are answerable by diffing repo state, and both
answer the only question with a live incentive behind it — a worker that already
failed a check and gets one more attempt.

**D5 — Novelty gate.** A critique is only sent if the reviewer can name
something the worker did not already address. "Looks good" never triggers a
round trip. Adapted for a mechanical reviewer: every finding must carry named
evidence, and findings without it are dropped rather than forwarded.

**D6 — Revise cap = 1.** After one revision the artifact flows to aggregation
carrying an explicit `unresolved: [...]` flag rather than being forced to a
false resolution.

**D7 — Aggregators read artifacts, not transcripts.** This is the
single-reader/multi-consumer constraint. It is the only mechanism in the system
that reduces total token count rather than relocating it.

**D8 — Graph-level budgets.** Cap total nodes, edges, and wall time in the
coordinator. On exhaustion, stop and aggregate what completed. Graceful
degradation over runaway spend.

**D9 — Checks are measured, not asserted.** The check matrix is a union
computed at validation time, never a list the worker declares. This makes
dropping a baseline check structurally impossible rather than merely
discouraged, and it is what stops the tester from being an unbounded opponent.

## Check matrix ownership

The tester is bounded *by* the matrix, so the matrix has to have an owner. None
of the four obvious candidates works alone:

- **Planner** — hasn't read the code; anything it says about this file's edge
  cases is a guess.
- **Worker** — has read the code, and has an incentive to clear its own bar.
  Self-grading.
- **Human** — highest quality, but per-task test criteria defeat the purpose.
- **Repo** — grounded, but only covers what is already tested.

So checks are split by kind, and each kind gets the owner that cannot game it:

| Kind | Owner | Gamed? |
|---|---|---|
| `baseline` — lint, typecheck, build, existing suite | Plugin setup, derived from repo config | No — authored once, not per task |
| `coverage` — changed lines | Tool-measured (`coverage --changed-lines`) | No — measured, never asserted |
| `intent` — cases from the user's stated request | Planner | No — hasn't seen the code, so cannot lower the bar |
| `judgment` — semantic and UX quality | Human, or **cut in v1** | Yes — no agent-side author is trustworthy alone |

Each check carries `gating: "blocking" | "advisory"` rather than a severity
scale. Severity was dropped because with `judgment` cut it could only ever take
two values, and gating is what actually decides whether a failure blocks an
artifact or merely annotates it.

Each check also carries `convergent: boolean`. Typecheck and the test suite
converge — one fix satisfies them. Coverage thresholds and complexity limits do
not: a worker told to hit 100% branch coverage thrashes without ever passing.
**Only `blocking` ∧ `convergent` failures may trigger a revise round.** A
blocking non-convergent check is rejected as `invalid-check`, because it can
never pass a revise round and only burns budget finding that out.

Two rules make this hold:

1. **The effective matrix is `baseline ∪ contract_checks`, computed by union.**
   A contract may add checks, never remove. On duplicate commands the baseline
   entry wins, so a contract cannot override a standing project rule.
2. **`judgment` is rejected by the validator in v1.** Not by prompt
   instruction — by `unsupported-check-kind`. Cutting it at the type and
   validation layer is cheaper than arguing with a model about semantics.

Consequence worth stating plainly: **v1 catches mechanical failures only.** No
"is the error message useful", no "does this flow make sense." That limitation
belongs in the README, not in a footnote.

### The tester role

Tester is distinct from UX and DevEx. It is the only role that finds problems
without being able to resolve them, which is exactly what generates loops.

- `writes: []` — read-only, so it can never collide with a worker by
  construction
- Executes a matrix it did not author and judges nothing
- Reports only *proven* failures — command output, stack trace — never
  suspicions
- Returns `{passed, failures[]}`, never a transcript, so a revise round stays
  cheap
- **Cannot request a revision.** The orchestrator schedules at most one, and
  re-verifies once. A tester asked to find failures has no satisfaction
  condition; the bound has to come from outside the model.

Only a failing check that is `blocking` ∧ `convergent` triggers a revision
round. Everything else is recorded and flows to aggregation as `unresolved`.

## Contracts carry no `verify` field

Earlier drafts had both `verify: "npm test -- src/a"` and `checks[]`. Two fields
that both mean "a command to run" is a bug factory, so `verify` is gone and the
gate runs all blocking checks. The guarantee it provided — a code contract has
something runnable against it — is preserved as `no-blocking-check`.

The coordinator sees the JSON Schema and its prose rules as one prompt, and its
output is parsed by a hand-rolled shape check (`coordinator/parse.ts`) that
enforces `additionalProperties: false`. A test asserts the parser and the schema
agree, so the two cannot drift silently.

## Cost model

The claim this project can defend, stated honestly:

> Orchestration makes independent work parallel. Naive multi-agent pays full
> context price per worker. Cubicore's contract layer cuts per-worker cost by
> **X%**, so the net is **Y%** of naive.

It cannot claim to be cheaper than a single agent, because it is not.

**Speedup is Amdahl-capped.** With planning at ~15% and aggregation at ~10% of
baseline, and 8 workers:

```
1 / (0.25 + 0.75/8) ≈ 2.9×
```

So ~3× on 8 workers, not 8×. Optimise the serial phases first — planner and
aggregator speed compound across every run; worker speed does not.

X and Y are **unmeasured**. Phase 0 exists to produce them. Until then this is
a hypothesis.

## Assumptions

Made without confirmation. Correct these first if any are wrong.

- **Runtime:** opencode plugin, TypeScript, Bun.
- **Workload:** code editing first. General prompts deferred — the `verify`
  field only has meaning for code.
- **Model routing:** strong model for plan + aggregate, cheaper model for
  workers. Biggest single cost lever, native in opencode config.

## Open questions

1. Target workload — code-only, or general prompts in the same contract schema?
2. Who runs the `verify` commands — the worker's sandbox or the plugin host?
3. Is the tester enabled by default? It roughly doubles per-artifact cost.
4. Does the token-saving claim survive contact with a real billing dashboard?
5. `convergent` is currently a flag the planner sets for itself. The one place
   it is *not* self-declared should be derived from what the repo can prove.
   Until then a planner can mark a thrashing check `convergent: true`.
6. Should `validatePlan` enforce role invariants, e.g. rejecting a tester
   contract that declares non-empty `writes`? Nothing enforces it today.

## Roles

Roles are **configuration templates, not the decomposition axis.** Role does not
imply a disjoint write set, and disjoint `writes` is the only thing the validator
checks. A role supplies defaults — persona, model tier, default `writeScope`,
default `verify`, per-task budget — and a contract overrides them.

- The validator reads `writes` only. `role` is provenance, never authority.
- **Headcount is a budget line item.** The planner proposes N workers; the graph
  budget rejects it. A plan asking for 12 workers against an 8-node budget
  fails validation rather than silently truncating.
- **Role diversity predicts topology.** Homogeneous roles suggest fan-out;
  mixed roles usually mean a dependency, i.e. a pipeline with ~1× speedup.
  Cheapest available detector for a mis-declared topology.
- "Unassignable" is a valid planner output, alongside `refuse`.

| Role | Writes? | Output | Loop risk |
|---|---|---|---|
| **Tester** | No — `writes: []` | pass/fail + failure list | Highest. Finds problems it cannot resolve |
| **UX** | Yes — styles, copy | diff | Medium. Subjective, always improvable |
| **DevEx** | Yes — CI, tooling | diff | Low. Mechanical, has a verify |

UX is currently **undesigned**: it has no `verify` command, so the gate
mechanism does not apply to it, yet it is the role most prone to the
"always improvable" loop.

## Prior art

opencode's `task` tool, `permission.task` gating, per-agent `model`, and
child-session context isolation already cover dispatch and topology. Third-party
plugins already handle depth limiting and container pooling.

The gap being filled here is **validation** — opencode lets you spawn agents and
control permissions, but nothing checks whether the plan was sane before the
spend. That is the product.

# Cubicore — Structure

## Layout

```
src/
  index.ts              plugin entry — registers tools, wires phases

  contracts/
    types.ts            Contract, Check, Budget, Plan, Topology [implemented]
    schema.ts           plan JSON Schema + planner prompt        [implemented]

  validate/
    overlap.ts          glob intersection                       [implemented]
    matrix.ts           check matrix union + kind gate          [implemented]
    plan.ts             validatePlan() — the moat               [implemented]

  coordinator/
    parse.ts            runtime shape check, MalformedPlan       [implemented]
    plan.ts             plan / validate / re-plan-once / fall back [implemented]
    topology.ts         classify task into one of four topologies  (Phase 5)

  dispatch/
    index.ts            fan-out driver, one retry total     [implemented]
    permissions.ts      Contract -> opencode V2 rules        [implemented, unverified]
    spawn.ts            opencode subagent adapter            [Phase 2, remaining]
    agents.ts           Contract -> opencode agent definition [Phase 2, remaining]
    budgets.ts          per-contract ceilings + graph budget (D8)  [Phase 3]

  gate/
    index.ts            three gates in order, stop at first fail [implemented]
    severity.ts         blocker-only revision trigger        [Phase 4]

  aggregate/
    index.ts            artifacts only — never transcripts   [implemented]

  review/
    index.ts            asymmetric critic, novelty gate, revise cap 1  (Phase 4)

  aggregate/
    index.ts            artifacts only — never transcripts (D7)

  telemetry/
    types.ts            provider-agnostic usage + report shapes     [implemented]
    usage.ts            UsageLedger — dedupe on repeated events     [implemented]
    timing.ts           PhaseTimer, injectable clock                 [implemented]
    analysis.ts         parallelism, serial fraction, compare()     [implemented]
    report.ts           RunRecorder + one-line CI summary           [implemented]
    adapters/
      opencode.ts       MessageInfo -> TokenUsage                   [implemented, unverified]

  bench/
    baseline.ts         single-agent baseline runner                 (Phase 0, remaining)

test/
  validate/plan.test.ts
  validate/matrix.test.ts
  coordinator/parse.test.ts
  coordinator/plan.test.ts
  telemetry/usage.test.ts
  telemetry/analysis.test.ts
  telemetry/telemetry.test.ts
```

## Responsibility boundaries

**`contracts/`** — types only. No logic, no I/O. If this module grows a
function, a decision was made in the wrong layer.

**`validate/`** — pure functions. Takes a plan, returns findings. No spawning,
no model calls, no filesystem. This is what makes it testable and what makes it
run before the spend.

**`coordinator/`** — the only layer that calls a model to *decide*. Everything
else executes decisions already made. `Planner` is an interface, so this is
testable against fixtures and swappable when Phase 3 routing lands.

**`contracts/schema.ts` vs `coordinator/parse.ts`** — the same shape, written
twice on purpose. The schema is what the model is shown; `parse.ts` is what the
response is checked against. There is a test asserting the two agree on required
properties, so they cannot drift silently.

**`dispatch/`** — the only layer that spawns agents. Translates a `Contract`
into an opencode agent definition and permission rules. It does not decide what
the workers do.

Two-way split: `permissions.ts` builds the rules and is fully tested;
`spawn.ts` is the opencode call and is the one place a provider SDK is touched.

**Retry budget is one round total, not one per gate.** A schema failure produces
a *different* artifact, so the whole chain re-runs; budgeting per gate would
allow four worker invocations for one contract, a 4× cost against a headline
cost claim. `shouldRetry` is the single place that decision is made.

**`gate/`** — pure-ish. Verifies artifacts against a contract and returns
verdicts. Knows nothing about workers or dispatch. Takes a `CommandRunner` so
it never shells out itself, which keeps the gates testable without a repo.

Gate order is `schema → verify → scope`. A malformed artifact has nothing to
verify, so the order is a dependency, not a preference.

`gateVerify` runs only checks that are `blocking` ∧ `convergent`. Advisory and
non-convergent checks are recorded by the caller and never gate, because neither
can be satisfied by one revision.

**`aggregate/`** — imports `contracts/` and `telemetry/` only. That restriction
is what makes D7 mechanical rather than a promise: the module is structurally
unable to reach a worker transcript.

**`aggregate/`** — reads artifacts off disk. Must not import `dispatch/` or
`coordinator/`, and must never receive a transcript. That constraint is what
enforces D7.

**`telemetry/`** — cross-cutting, imported by everything. Never imports from
the rest of the project, and its core never imports an SDK. Provider specifics
live in `telemetry/adapters/`, so adding Claude Code support means writing an
adapter, not editing the report schema. The run report is the artifact the cost
claim is made from — its shape has to outlive any single host.

**`bench/`** — the baseline runner. Separate from `telemetry/` because it drives
opencode itself rather than observing it, and must not be importable by the
plugin.

## Dependency rule

```
telemetry  →  (nothing)
contracts  →  telemetry
validate   →  contracts, telemetry
coordinator→  contracts, telemetry
dispatch   →  contracts, telemetry, validate
gate       →  contracts, telemetry
review     →  contracts, telemetry, gate
aggregate  →  contracts, telemetry, gate
```

Imports flow downward only. Two rules worth defending in review:

- **`aggregate/` must not import `dispatch/` or `coordinator/`.** If it needs
  something from them, the abstraction is wrong — artifacts should be
  self-sufficient.
- **`validate/` must not import model or I/O code.** It runs before the spend;
  a plan validator that can fail by calling a model is not a validator.

## What is deliberately absent

- No agent loop. opencode runs the workers.
- No chat/message bus between agents. Artifacts only (non-goal).
- No model client outside `coordinator/` and the eventual `review/`. Budget
  enforcement needs a single choke point, and spreading it across modules makes
  it unenforceable.
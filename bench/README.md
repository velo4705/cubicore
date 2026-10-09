# Cubicore — Benchmarks

The cost claim lives or dies here. Everything else in this repo is
infrastructure; this directory is the part that can prove the pitch or refute
it.

## What is being claimed

The pitch has two numbers and neither is currently real:

> Orchestration makes independent work parallel. Naive multi-agent pays full
> context price per worker. Cubicore's contract layer cuts per-worker cost by
> **X%**, so the net is **Y%** of naive.

- **N** — the speedup
- **X** — per-worker cost reduction
- **Y** — net cost against naive fan-out

All three come out of the same experiment.

## The three arms

| Arm | What it is | Why it exists |
|---|---|---|
| `single` | One agent, whole task, no orchestration | The reference point for speedup |
| `naive-fanout` | N agents, each independently loading full context | **The control the pitch competes against** |
| `orchestrated` | Cubicore | The product |

The `naive-fanout` arm is the one that matters most and the one most systems
skip. "Cubicore is faster than one agent" is easy and not the claim. The claim
is that the contract layer beats what you would otherwise have written — N
independent agents, no coordination. That control has to be measured, not
modelled.

## Why repeated trials, not one run

Agent duration and token counts are heavy-tailed. A single run is not a
measurement. The rules baked into `aggregate.ts`:

- **Median, not mean.** One retry storm skews a mean enough to bury a regression.
- **Paired ratios.** Every task runs under every arm, so each comparison is
  within-task. A ratio of medians across arms conflates "Cubicore is faster"
  with "this task was slow for everyone."
- **Spread reported with the median.** A 2× speedup with 4× spread is not a
  speedup. `Claim.stable` goes false and the number does not get published.
- **Arms interleaved**, not blocked, so a slow patch cannot land on one arm only.

## Running it

The benchmark drives opencode from the **outside**, deliberately. The plugin
grading its own runs would be the same circularity that makes an agent's
self-reported completion untrustworthy — it would invalidate the only number
this project has to sell.

```bash
bun run bench                       # full corpus
bun run bench -- --task t1 --reps 5 # one task, five repetitions
```

## Known opencode obstacles — verified

Two documented bugs shape the implementation, and both have now been checked
against a real install rather than inferred:

- [#28407](https://github.com/anomalyco/opencode/issues/28407) — `opencode run`
  requires an existing session and does not create one.
- [#31404](https://github.com/anomalyco/opencode/issues/31404) — `run --format json`
  emits only `step_start`; token data never reaches stdout.

Both hold. **Token counts must come from the session database.**

### What the database actually looks like

Checked against `~/.local/share/opencode/opencode-stable.db`:

- The `message.data` token block is **nested**, not flat:
  `{ input, output, reasoning, cache: { read, write } }`. An earlier adapter
  guessed `cacheRead` / `cacheWrite` flat — that branch was dead code and has
  been deleted against the real shape.
- `cost` is a **sibling** of `tokens` on the message, not a field inside it.
- `role` is stored as a plain **string** (`"assistant"`), not `{ type }`. The
  adapter handles both spellings; missing this silently counted user messages.
- The `session` table carries **denormalised columns** —
  `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`,
  `tokens_cache_write`, `cost`, plus `time_created` / `time_updated`.

That last point is the useful one: a measurement is **a single row read**, not a
scan of the message table. It is faster, and it cannot double-count the repeated
`message.updated` events the streaming bus emits. `readSession` keeps a message
aggregation as a fallback for a schema without those columns.

## Current state

The measurement loop works end to end: `opencode run` → session created →
tokens read back through `SqliteTokenSource`. Confirmed against real sessions
on this machine.

### What running it actually found

**1. The bootstrap prefix is ~36K tokens, and it caches permanently.**

Four identical trivial runs (`Reply with exactly: OK`), same model, same
directory:

| run | input | cacheRead | output |
|---|---|---|---|
| 1 (cold) | 34,158 | 1,943 | 3 |
| 2 | 1 | 36,100 | 3 |
| 3 | 1 | 36,100 | 3 |
| 4 | 1 | 36,100 | 3 |

System prompt plus tool definitions are a **fixed ~36K-token prefix per
session**, and after the first run it is served entirely from cache — stably,
over hours.

Two consequences, both load-bearing:

- **This is the cost floor a naive fan-out pays N times.** Splitting a task
  eight ways pays that prefix eight times. That is precisely the "full context
  price per worker" this project claims to cut, and it is now a measured number
  rather than an intuition.
- **Any benchmark must report cache state.** A cold arm and a warm arm of the
  *same* task differ by ~36K tokens for reasons that have nothing to do with
  orchestration. Interleaving arms handles drift; it does not handle cache
  warmth. Arms need either a cold prefix or an explicitly warm one, consistently.

**2. `durationMs` is session lifetime, not work time.** A session left open
across days reports 35 hours. Historical sessions are therefore not a valid
benchmark source; measurement has to use freshly created sessions.

**3. First real measurements taken — see `RESULTS.md`.**

4-way naive fan-out cost **4.05× the tokens** (stable across all trials) and
bought **no speedup** — 1.07× median, i.e. marginally slower than one agent. The
cost side of the claim is measured against the control that matters.

X and Y remain unmeasured: the `orchestrated` arm needs an opencode plugin entry
point that does not exist yet, so Cubicore has never been run.
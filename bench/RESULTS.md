# First real measurements

Produced by `bun run bench` on 2026-10-09. Model `opencode/space-bunny-free`,
scratch repo at `/tmp/opencode/benchrepo` (4 generated modules, 134 lines each).

## What was measured

| Arm | n | mean wall | mean tokens |
|---|---|---|---|
| `single` — one agent, whole task | 4 | 19,555 ms | 148,070 |
| `naive-fanout` — 4 independent agents, concurrent | 4 | 80,479 ms | 648,641 |

Per trial:

```
task rep | single ms  naive ms  ratio | single tok  naive tok  token ratio
t1   1   |    20105     19439  0.97x |     109105      295852  2.71x
t1   2   |    17733     19022  1.07x |     111185      444588  4.00x
t2   1   |    17634     25707  1.46x |     147641      604696  4.10x
t2   2   |    22746    257749 11.33x |     224022     1242048  5.54x
```

- **median wall ratio: 1.07×** (1.27× including the outlier)
- **median token ratio: 4.05×** (range 2.71–5.54)

## The headline

**4-way naive fan-out cost 4× the tokens and bought no speed** — it was
marginally *slower* than one agent.

That is the premise holding. Fan-out without coordination is not a free
parallelism win; it is a ~4× cost multiplier. The token ratio is stable across
every trial, which is what makes it believable.

## What this does and does not establish

It establishes the **cost side** of the claim, against the control that matters.
The naive arm was run **concurrently**, deliberately — running it sequentially
would have made the baseline look bad for reasons unrelated to orchestration.

It does **not** establish:

- **X or Y.** `src/index.ts` now exists and `bench/cubicore.ts` drives Cubicore's
  own plan → dispatch → gate path against a live client, but the `orchestrated`
  arm has not yet been run over the corpus. Every figure here is still the
  baseline, never Cubicore.
- **A speedup claim.** 1.07× is "no change," not a win. These tasks are small and
  the model is fast, so the ~36K session prefix dominates and there is little
  serial work to overlap. On longer tasks with a slower model the wall-clock
  picture would differ — this corpus cannot say either way.

## Caveats that bound these numbers

- **One outlier.** t2 rep 2 took 4.3 minutes for the naive arm against ~20 s for
  the others. It skews the mean badly; the medians above exclude it and the token
  ratio is unaffected (5.54× is the outlier's, and it is still in range).
- **Cache state varies between reps.** Run 1 of each task is cold; later reps hit
  the ~36K prefix cache. Both arms experience this equally, but it is why rep 1
  shows a different input/cache split.
- **n=4.** Enough to see a 4× effect, not enough to characterise variance. The
  wall-clock claim needs more reps before it means anything.
- **Free fast model.** A slower model would shift the wall-clock balance toward
  fan-out, since serial work would be more worth overlapping.
- **Small, genuinely separable tasks.** By design — the corpus is what Cubicore
  claims to handle. Interface changes and cross-cutting refactors are excluded
  because Cubicore is designed to refuse them.

## What to do next

Build the plugin entry point so the `orchestrated` arm can run. Until then the
comparison is one-sided: we know what the thing we compete with costs, and
nothing about what we cost.
---

# The three arms, 2026-10-21

Twelve contracts over twelve generated modules (1716 lines). Model
`opencode/minimax-m3.1-flash-free`. The naive arm was capped at three
concurrent workers, and the orchestrated arm dispatched all twelve.

| Arm | wall | input | output | cache read | total tokens |
|---|---|---|---|---|---|
| single — one agent, whole task | 597,194 ms | 37,914 | 10,184 | 8,835,468 | **8,883,566** |
| naive x12 — twelve independent, uncoordinated | 1,564,233 ms | 583,836 | 120,376 | 96,053,753 | **96,757,965** |
| orchestrated — Cubicore, twelve contracts, gated | 541,807 ms | 2,733,721 | 57,202 | 24,993,962 | **27,784,885** |

Twelve of twelve contracts passed every gate: `schema:ok verify:ok scope:ok`.

**Not a single controlled run.** The single and naive figures come from one
benchmark run; the orchestrated figure from a separate arm run against the same
fixture. The ratios are large enough to survive that, but the digits are not
from one clock.

## The ratios, and what they mean

| Comparison | Wall | Tokens |
|---|---|---|
| orchestrated vs **naive fan-out** | **2.9× faster** | **3.5× cheaper** |
| orchestrated vs **single agent** | 1.1× — parity | 3.1× **more expensive** |
| naive fan-out vs single agent | 2.6× **slower** | 10.9× **more expensive** |

Three things follow, and only the first is the one usually claimed.

**Fan-out without coordination is not free parallelism.** It cost 10.9× the
tokens of one agent and was *slower*. Every worker loaded the whole repository
into its own context, and nothing stopped them from colliding.

**Cubicore beats naive fan-out on both axes** — 2.9× faster and 3.5× cheaper.
The mechanisms are separate: narrower write scopes mean each worker reads less,
and the gates mean the pipeline knows when a worker is finished rather than
guessing.

**Cubicore does not beat one agent.** On twelve small files it was level on
wall clock and cost 3.1× the tokens. The work was too small to need parallel
workers, and the model, not the split, was the bottleneck.

## So is "9 hours becomes 4" right?

Directionally, and against the control that matters. But the mechanism is not
"splitting of tasks" on its own — splitting without enforcement is what made
naive fan-out *slower* than doing nothing in parallel.

Two conditions have to hold, and neither is about Cubicore:

1. **The work must be genuinely independent.** The 2.9× is against twelve
   independent contracts. Coupled work — a shared type, a dispatcher, an
   integration step — does not parallelise, and the plan's own topology check
   is what catches that before anything is spent.
2. **The serial fraction must be small enough.** Amdahl, and the ceiling is
   below the 3.5× Amdahl figure because the gates and the plan cost something
   too. A project with four hours of coupled core and five of independent work
   does not become 9→4; it becomes something nearer 9→6.5, plus verification
   the serial path never had.

**And the claim needs a floor.** On small work Cubicore is overhead: 3.1× the
tokens for parity in wall clock. Splitting a two-hour task into four agents
saves nothing and costs a plan, four contexts and four gate chains.

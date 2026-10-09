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
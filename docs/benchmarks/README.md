# Benchmark evidence

How Cubicore's numbers are produced, recorded, and published. Everything in this
directory must trace to `runs.jsonl`; nothing here may be drawn, typed, or
remembered directly into a claim.

## Ground rules

1. **No number from one run.** A claim needs at least 3 runs per arm, or it is an
   anecdote and it is labelled `n=1` or not published at all.
2. **Unknown is printed as `unknown`.** A cell with no measurement is never `0`
   and never omitted — it is the difference between "not measured" and "it was free".
3. **All arms, all outcomes.** Failed runs, flat screenshot verdicts, and post-dispatch
   human fixes are part of the evidence. Excluding them is fabrication.
4. **Identical inputs.** The same brief, verbatim, for every arm. Same repo commit. Same
   checks. Same host, same model, same session budget. If an arm edits its inputs
   (e.g. refining the brief mid-run), record the delta in `note`.
5. **Holdout stays holdout.** A task used to tune anything is no longer evidence.
   The holdout task must have been picked before the first run, and must not be
   re-run for tuning between rounds.
6. **The founder publishes, not the factory.** Cubicore records; the founder decides
   what to claim. A benchmark Cubicore grades itself on has no standing.

## The protocol (Phase 5 — see ROADMAP/TODO)

Tasks to pick from (pick one, keep one holdout): 3D world / browser game, REST API,
CLI, migration, bugfix on a known repo.

Arms:

- **one-agent** — the host's agent, single session, the same brief.
- **cubicore** — full Cubicore flow (plan → approve → execute), session dispatch
  path preferred so token usage is measurable. Inline dispatch structurally cannot
  report tokens on this host (`usageMethod: inline — host tokens not collected`);
  inline runs may only contribute to wall-time and pass-rate, and their token cells
  are `unknown`.

Per run, recorded into `runs.jsonl`:

| field | meaning |
|---|---|
| task | frozen brief identifier + where the brief lives |
| arm | `one-agent` \| `cubicore` (`cubicore-inline` allowed, tokens = unknown) |
| run | run number within the arm (1..N) |
| startedAt | ISO timestamp |
| durationMs | wall clock of the WHOLE task, from first edit to merged tree green (not the Cubicore dispatch span alone) |
| tokens | measured host usage if the host reports it (`session` path), else `null` |
| buildGreen | `npm run build` / equivalent for the delivering arm |
| playwright | smoke test outcome if the brief demands one |
| visualVerdict | `ok` \| `flat` \| `null` |
| accepted / failed / deferred | per-arm contract outcomes |
| escapes | write-scope escapes (count + named files are in the project ledger) |
| interventions | number of post-dispatch human/orchestrator fixes, and what class |
| note | anything a reader must know to interpret the row |
| source | `seed` (backfilled import) \| `recorded` (measured run) — seeds are never benchmark-grade |

Report (script: `bun scripts/benchmark-report.mjs`) renders `report.html` from
`runs.jsonl` only: a row per run, medians per arm per metric, `unknown` cells
printed as unknown, and the screenshots grid if present. No manual edits to
`report.html` — it is regenerated, and the run rows are the source of truth.

## What is deliberately NOT here yet

- **No benchmark-grade numbers.** The three rows in `runs.jsonl` are backfilled
  seeds from 2026-11-15 runs (`project-1`, `project-2`, `project-6`) with tokens,
  wall time and interventions recorded as `unknown` — their `visualVerdict` is `flat`
  in all three. They exist so the schema and the report are real; they are not
  comparative evidence and must not appear in a claim.
- **No single-agent arm exists yet.** Any claim of relative performance would be
  invented at this point.

# TODO

Cubicore's open work, in checklist form. Rationale and history live in
`docs/archive/completed-milestones.md`; prior framing is in that file too.
Empty this file by shipping items one at a time.

Regression-style rule for adding new items: an item lands here only if it was
**not already done** — see the archive before proposing. And if an item
appears wrong, read `docs/archive/completed-milestones.md` first — it may be
done there.

## Priority order (dependency-driven)

- [ ] Phase 5 — the only one allowed to publish claims; nothing happens until 1–4 land
- [ ] Phase 4 — continuous-project support (after Phase 3 is portable)
- [ ] Phase 3 — host portability, the second host, the single biggest jump in credibility
- [ ] Phase 2 — strengthening runtime behaviour — remaining exit criteria

## Phase 2 — Strengthen runtime behaviour (remainders)

- [ ] Conflict and collision reporting from actual changed files
- [ ] Adaptive split/merge/skip decisions on a gate failure
- [ ] Narrowed revision named by the factory on gate failure (replaces "merge whatever changed")
- [ ] Cancellation and resume rigour — verdict per contract persisted, not only per task
- [ ] Factory dashboard / readable status — all worker states
- [ ] Handoff artifacts verified when passed between waves — not a promise
- [ ] Collision reporting per-file from actual diffs (artifact has *which* worker wrote *which* file)
- [ ] No two associates own the same file, or the founder is told by name (union-scope does not attribute; this does not claim it can)
- [ ] Cancel + audit on an in-flight contract — verdict per contract, not only per task

## Area 2 — Wave-failure mechanics (also Phase 2)

- [ ] Industry-style fix workflow: fail a gate → explicitly named narrower contract back (not "merge whatever changed")
- [ ] Adaptive split/merge/skip when workers discover they own one file
- [ ] Replace an unavailable capability with the strongest available one
- [ ] Stop spending on work cheaper as one agent
- [ ] Handoff artifact checks: consumer's `reads` must exist and pass their own gate before dispatching the consumer
- [ ] Collision from actual diffs: per-file attribution proposal; if the host cannot, the founder gets the union and a clear "not attributable" line

## Area 3 — Portability (Phase 3)

- [ ] Adapter interface answering the same questions on every host: inline sub-agents, child sessions, worktree isolation, tool/filesystem permissions, lifecycle stream, cancel, config-vs-plugin split
- [ ] OpenCode reference adapter
- [ ] Claude Code adapter (first named)
- [ ] Codex adapter (second named)
- [ ] Session fallback for hosts without inline sub-agents
- [ ] Config-first agent registration and host-specific doctor checks
- [ ] Cross-host smoke suite: plan → dispatch → gate → integrate → verify, on one second host
- [ ] Host adapters declare limits instead of faking capabilities
- [ ] Verify on a second host the same plan builds green — one config line to switch
- [ ] Verify wildcard on the wire: does the host actually refuse a disallowed tool call (read-back not yet done — the founder's call)

## Area 4 — User-Visible Value (Phase 2 remaining)

- [ ] Collision/scope-violation surfaced to founder (not buried in `unresolved[]`)
- [ ] Archive of plan-and-run context across runs — one place, not `CUBICORE_PLAN*.md` archaeology
- [ ] Tight summary after run: done / not done, what to do next, one line
- [ ] Exit: the founder can answer "what is Cubicore doing right now?" via one command (largely true — keep)
- [ ] Exit: a blocked run tells the founder exactly one next move (partially true — `escalatedLine` prints it; audit ends here)
- [ ] Exit: nothing the founder sees is unverified — unverified lines print as unverified (keep)

## Phase 4 — Continuous-project support

- [ ] Incremental plans over existing projects
- [ ] Stable contract IDs surviving plan rewrites
- [ ] Preserve green work across runs — re-run only affected contracts (requires reason or digest, not "the file changed")
- [ ] Delta briefs — briefs for additions/removals
- [ ] Regression ledger and change-impact report
- [ ] Repeated-cycle benchmark on a living codebase
- [ ] Exit: a twenty-change project runs repeated cycles without resetting
- [ ] Exit: previously green work survives unrelated changes
- [ ] Exit: regression failures localised and attributable
- [ ] Exit: each cycle leaves the project more verified than before

## Phase 5 — Prove the value

- [ ] Public benchmark set (3D world, API, CLI, migration, bugfix) — pick one, keep one holdout
- [ ] Identical inputs for one agent, naive fan-out and Cubicore
- [ ] Publish time, tokens, defects, founder interventions
- [ ] Hold-out tasks so tuning can't overfit the benchmark
- [ ] Turn into advertised claims only if they survive
- [ ] Exit: the reference task beats or approaches the one-agent number
- [ ] Exit: token saving reproduced, not anecdotal
- [ ] Exit: the factory-fit decision predicts when fan-out pays
- [ ] No cost or speed claims anywhere until this passes

## Deferred: faster and cheaper (ordered)

- [ ] Lean the brief — exact file list, one check command, exact report format (not done)
- [ ] Fix the `worker.prompted` late-fire + make `cancel` real — the event stream side is now done; rename/reason settlement remains
- [ ] Concurrency cap — cap `dispatch`'s stage-sized `Promise.all` (load-70 problem — not done)
- [ ] Measure once — A/B after the cheap wins, not before (blocked by the three above)

## Deferred: cost & budget for every step

- [ ] Plan tool derives mechanical parts (contract ids, graph budget defaults, baseline check union, wave edges) — hand-written schema drift goes away
- [ ] Aggregate machine-readable artifacts mechanically — prose stays to the Main agent, not the artifact
- [ ] Worktree scoping — full-repo checkout per worker is 36 git ops for twelve workers, index-lock contention
- [ ] Check dedupe at run time — same command, one run
- [ ] Research survey cached per directory — re-walk only on re-plan
- [ ] Single-reader topology (D7) — design change, wait for 3+4 to land + measure
- [ ] Not before, not ever: "smart" replanning spending more than the project

## Org-scale record (missing shipped work)

- [ ] Verification cost at org scale is unknown and may be enormous; narrow gate scope is the org's responsibility, not Cubicore's (requires a founder decision)
- [ ] Phase 7-class work: continuous-cycle support — nothing in the repo supports repeated runs on an evolving codebase
- [ ] Org conventions cannot be discovered by Cubicore — process friction and token tax never go away; the org must carry the invariants in briefs or CI

## Decisions to make

- [ ] Phase 0 vs Phase 5 ordering: no benchmark without these (currently: benchmark still unmeasured)
- [ ] Single-reader topology: worth designing now or wait for cost-budget plan?
- [ ] File claims of speed/cost in README before measurement? No.
- [ ] Publish 1.0.8 with the observer fix (1.0.8 in tree; smoke done; live untested) — when?
- [ ] Fold "2026-11-13 ideas" into phases or keep them parked? Currently parked: design-intake, live preview, external-tool MCPs (Unity/Godot/Arduino)

## Known-state open defects and unknowns (not milestones — fact)

- [ ] Live dispatch of the observer fix on the founder's host — founder's call (requires re-running `setup`)
- [ ] Wire-level verification of the wildcard deny-on-this-host (scratch evidence only)
- [ ] 1.0.8 published on npm or held for a smoke pass? Currently unpublished

If an item appears wrong, check `docs/archive/completed-milestones.md`
first — it may have already been done there.

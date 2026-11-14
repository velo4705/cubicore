# TODO

Cubicore's open work, in checklist form. Rationale and history live in
`docs/archive/completed-milestones.md`; this file carries only what is not
done. Empty this file by shipping items one at a time.

Rule for adding an item: it lands here only if it was **not already done** —
see the archive before proposing. If an item appears wrong, check there first.

## Priority order (dependency-driven)

- [ ] Phase 5 — the only one allowed to publish claims; nothing happens until 1–4 land
- [ ] Phase 4 — continuous-project support (after Phase 3 is portable)
- [ ] Phase 3 — host portability, the second host, the single biggest jump in credibility
- [ ] Phase 2 — strengthening runtime behaviour — remaining exit criteria

## Phase 2 — Strengthen runtime behaviour (remainders; open only)

- [ ] Adaptive split/merge/skip decisions on a gate failure
- [ ] Narrowed revision named by the factory on gate failure (replaces "merge whatever changed")
- [ ] Cancellation and resume rigour — verdict per contract persisted, not only per task
- [ ] Factory dashboard / readable status — all worker states
- [ ] Handoff artifacts verified when passed between waves — not a promise
- [ ] Collision reporting per-file from actual diffs (artifact has *which* worker wrote *which* file) — **attribution not available on opencode 2.1.3; the union is all this host will say**
- [ ] No two associates own the same file by name — union-scope does not attribute; resolved when the host gains per-session attribution

## Area 2 — Wave-failure mechanics (also Phase 2; open only)

- [ ] Industry-style fix workflow: fail a gate → explicitly named narrower contract back (not "merge whatever changed")
- [ ] Adaptive split/merge/skip when workers discover they own one file
- [ ] Replace an unavailable capability with the strongest available one
- [ ] Stop spending on work cheaper as one agent
- [ ] Handoff artifact checks: consumer's `reads` must exist and pass their own gate before dispatching the consumer
- [ ] Collision from actual diffs: per-file attribution proposal; if the host cannot, the founder gets the union and a clear "not attributable" line

## Area 3 — Portability (Phase 3; open only)

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

## Area 4 — User-Visible Value (open only)

- [ ] Archive of plan-and-run context across runs — one place, not `CUBICORE_PLAN*.md` archaeology
- [ ] Tight summary after run: done / not done, what to do next, one line
- [ ] Exit: a blocked run tells the founder exactly one next move (partially true — `escalatedLine` prints it; audit ends here unless the host supports attributed idle)
- [ ] Exit: nothing the founder sees is unverified — unverified lines print as unverified (keep)

## Phase 4 — Continuous-project support (open only)

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

## Phase 5 — Prove the value (open only)

- [ ] Public benchmark set (3D world, API, CLI, migration, bugfix) — pick one, keep one holdout
- [ ] Identical inputs for one agent, naive fan-out and Cubicore
- [ ] Publish time, tokens, defects, founder interventions
- [ ] Hold-out tasks so tuning can't overfit
- [ ] Turn into advertised claims only if they survive
- [ ] Exit: the reference task beats or approaches the one-agent number
- [ ] Exit: token saving reproduced, not anecdotal
- [ ] Exit: the factory-fit decision predicts when fan-out pays
- [ ] No cost or speed claims anywhere until this passes

## Deferred: faster and cheaper (open only)

- [ ] Lean the brief — exact file list, one check command, exact report format
- [ ] worker.prompted still emits after turn completion (before the events side is fixed, this is expected; the name is wrong — keep tracking until it is the host, not the observer)
- [ ] Concurrency cap — `dispatch` already accepts `maxConcurrency` but nothing wires it; no caller uses it
- [ ] Measure once — A/B after the cheap wins, not before (blocked by the three above + ~518k tok/tier measured and shipped)

## Deferred: cost & budget for every step (open only)

- [ ] Plan tool derives mechanical parts (contract ids, graph budget defaults, baseline check union, wave edges) — hand-written schema drift goes away
- [ ] Aggregate machine-readable artifacts mechanically — prose stays to the Main agent, not the artifact
- [ ] Worktree scoping — full-repo checkout per worker is 36 git ops for twelve workers, index-lock contention
- [ ] Check dedupe at run time — same command, one run
- [ ] Research survey cached per directory — re-walk only on re-plan
- [ ] Single-reader topology (D7) — design change, wait for 3+4 to land + measure
- [ ] Not before, not ever: "smart" replanning spending more than the project

## 2026-11-13 ideas — status recorded, not scheduled

None of these is committed as work, just tracked here so they are not lost:

- [x] Design intake & variant-pick gate — Phase A shipped 2026-11-14 (`reference` on UI plans, enforced); Phase B shipped same date (`variants` / `variant_pick` tools)
- [ ] Live preview during dispatch — `previewIt` exists; inline sidecar wiring not done
- [x] External-tool MCP wiring — `host_tools` MCP + `tool-hint.ts` shipped 2026-11-14; founder's engines (Godot/Blender/Arduino etc.) still need host MCPs declared in `opencode.json`
- [ ] Org-scale record (recorded, no commitment)
- [ ] Host-tools mismatch verification on the wire (scratch, not live)

## Done this cycle (do not propose again without checking the archive)

- [x] Collision escapes named in the founder's retrospective and both ledgers — 2026-11-14
- [x] `record_inline_run` creates an inline ledger with unknown usage when the host exposes none — 2026-11-12
- [x] `.cubicore-escalations.json` tracks blocked contracts with attempts counted across verify cycles — 2026-11-12
- [x] Role authority shipped in the dispatch prompt (name, capabilities, deny-all MCP wildcard) — 2026-11-12
- [x] Idle observer env/event paths fixed; `/event` → `/api/event`; `waitForIdle` races event and DB every 250 ms — 2026-11-13
- [x] Role tool policy actually wired into association agents' permission; wildcard MCP deny enforced at config-build — 2026-11-13
- [x] Design-variant renderer (`variants`) and pick recorder (`variant_pick`) shipped — 2026-11-14
- [x] Brief quality bar in the dispatched brief — 2026-11-14
- [x] Reference field required on UI plans; validator rejects without one — 2026-11-14
- [x] `host_tools` MCP tool: live read-back of what this host declares — 2026-11-14
- [x] 1.0.9 packed & smoke-verified by me — 2026-11-14 — but **1.0.9 (2026-11-13T16:45Z) on npm contains 17 tools and none of the work referenced above; local tree runs ahead, unpublished**

## Decisions to make

- [x] 1.0.9 vs 1.1.0 — **1.0.9 published 2026-11-13T16:45Z.** Verified 2026-11-14: the npm artifact contains the 17-tool surface, **not** today's additions. Today's additions (`host_tools`, `variants`, `variant_pick`, `reference`-gate on UI plans, scope-escapes in the ledger, brief quality bar) are in the tree only and ship in the next release — semver says that release is 1.1.0, not 1.0.10
- [ ] Next release numbering — decide: 1.1.0 (breaking behavior on UI plans) or hold to a smoke dispatch?
- [ ] Single-reader topology: worth designing now or wait for cost-budget plan?
- [ ] File claims of speed/cost in README before measurement? No.
- [ ] Fold any of the 2026-11-13 ideas into phases now, or leave parked?

## Known-state open defects and unknowns (not milestones — fact)

- [ ] Live dispatch of the observer fix on the founder's host — founder's call (requires re-running `setup`; the stdio handshake only validates the wire, not a live dispatch)
- [ ] Wildcard deny on wire-level on this host — scratch-verified at config-build layer; never dispatched
- [ ] Budget-exhausted fix — shipped in **1.0.9** on npm; live install on the founder's host still behind setup's pending restart

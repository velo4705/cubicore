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
- [x] Cancellation and resume rigour — verdict per contract persisted, not only per task — ledger carries done/flagged/blocked/deferred/reused per contract in both execute and inline paths (1.1.3) — checked 2026-11-16
- [x] Factory dashboard / readable status — all worker states — describe() renders every contract (icon, writes, counts, stage, elapsed, escalation next moves, union-pick attribution footer, steps tally) — checked 2026-11-16
- [ ] Handoff artifacts verified when passed between waves — not a promise
- [ ] Collision reporting per-file from actual diffs (artifact has *which* worker wrote *which* file) — **attribution not available on opencode 2.1.3; the union is all this host will say**
- [ ] No two associates own the same file by name — union-scope does not attribute; resolved when the host gains per-session attribution

## Area 2 — Wave-failure mechanics (also Phase 2; open only)

- [ ] Industry-style fix workflow: fail a gate → explicitly named narrower contract back (not "merge whatever changed")
- [ ] Adaptive split/merge/skip when workers discover they own one file
- [ ] Replace an unavailable capability with the strongest available one
- [ ] Stop spending on work cheaper as one agent
- [ ] Handoff artifact checks: consumer's `reads` must exist and pass their own gate before dispatching the consumer
- [x] Collision from actual diffs — host cannot attribute (opencode 2.1.3); the union verdict + "not attributable" line now prints in gate detail, retrospective, /cubicore:status, and every ledger — per-file attribution remains host-blocked; the escape hatch this item allowed is fully shipped — checked 2026-11-16

## Area 3 — Portability (Phase 3; open only)

- [ ] Adapter interface answering the same questions on every host: inline sub-agents, child sessions, worktree isolation, tool/filesystem permissions, lifecycle stream, cancel, config-vs-plugin split
- [ ] OpenCode reference adapter
- [ ] Claude Code adapter (first named)
- [ ] Codex adapter (second named)
- [ ] Session fallback for hosts without inline sub-agents
- [ ] Config-first agent registration (doctor checks shipped 2026-11-26: `npx cubicore doctor` reports credentials, port, live session-create, model config, MCP registration and plan state)
- [ ] Cross-host smoke suite: plan → dispatch → gate → integrate → verify, on one second host
- [ ] Host adapters declare limits instead of faking capabilities
- [ ] Verify on a second host the same plan builds green — one config line to switch
- [ ] Verify wildcard on the wire: does the host actually refuse a disallowed tool call (read-back not yet done — the founder's call)

## Area 4 — User-Visible Value (open only)

- [x] Archive of plan-and-run context across runs — 2026-11-26: `.cubicore-archive.jsonl` records plan digest, run id, mode, topology and verdict
- [x] Tight summary after run: done / not done, what to do next, one line — execute/debug replies end with a Next: line derived from disk state via nextLine(); the retrospective carries the done/not-done split — checked 2026-11-16
- [x] Exit: a blocked run tells the founder exactly one next move — escalatedLine prints the single next move with the attempt count; attributed idle does not exist on this host, so this is where the audit ends, exactly as the item anticipated — checked 2026-11-16
- [ ] Exit: nothing the founder sees is unverified — unverified lines print as unverified (keep)

## Phase 4 — Continuous-project support (open only)

- [ ] Incremental plans over existing projects
- [x] Stable contract IDs surviving plan rewrites — 2026-11-26: fingerprint from writes and checks; green work reused after an id rename
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
- [x] worker.prompted renamed to worker.prompt-sent (2026-11-17); host never signals idle, i.e. it is not the observer's bug; keep the tracking item until the host emits it

- [x] Concurrency cap — 2026-11-24: plan-declared `maxConcurrency` parsed and wired from execute; no mode cap; unbounded by default
- [ ] Measure once — A/B after the cheap wins, not before (blocked by the three above + ~518k tok/tier measured and shipped)

## Deferred: cost & budget for every step (open only)

- [ ] Plan tool derives mechanical parts (contract ids, graph budget defaults, baseline check union, wave edges) — hand-written schema drift goes away
- [ ] Aggregate machine-readable artifacts mechanically — prose stays to the Main agent, not the artifact
- [ ] Worktree scoping — full-repo checkout per worker is 36 git ops for twelve workers, index-lock contention
- [x] Check dedupe at run time — 2026-11-24: identical commands share one execution within a gate evaluation; later rounds still re-run
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
- [x] 1.0.9 packed & smoke-verified by me — 2026-11-14 — superseded by 1.1.0 (2026-11-14T13:24Z), then 1.1.1 (same day), 1.1.2 (2026-11-15T11:13Z) and 1.1.3 (2026-11-15T14:58Z). npm 1.1.3 is the product; everything after `b21bb4b` is in this tree, unpublished

## Decisions to make

- [x] 1.1.0 is published on npm (2026-11-14T13:24Z) — contains everything shipped today (observer fix, `/api/event` pump, `waitForIdle` race, reference gate, variants/variant_pick, host_tools, scope escapes, role walls, brief quality)
- [x] Visual first-shot loop wired: screenshotCheck + retrospective + ledger carry verdict — flat never fails, but is unmistakably reported
- [x] Asset kits required (keywords trigger `missing-assets` in validator); gateStyle accepts palette ∪ asset hexes
- [x] Planner hand-writing hardening — plan prompt forbids writing plan JSON to disk; dispatch already refuses a missing plan file — 2026-11-16
- [x] `plan_coverage` tool + module — mechanical token-overlap coverage of brief-vs-plan, named unaddressed asks, no oracle claims — 2026-11-16
- [x] Team-based prompting — brief mentioning a team/members → N numbered plans (leader takes `CUBICORE_PLAN_1`), self-describing member files, plan-time cross-plan surfacing, team-aware next-step — 2026-11-16
- [x] Factory ledger carries per-contract verdicts (`done`/`flagged`/`blocked`/`deferred`/`reused`) with an `attribution: "union"` marker, in both execute and inline paths — 2026-11-16
- [x] "Not attributable — verdicts rest on the union of declared writes" line in scope gate detail, retrospective, and `/cubicore:status` (multi-worker) — 2026-11-16; per-file attribution remains host-blocked
- [x] Planner no longer asks about direction if not specified
- [ ] Single-reader topology: worth designing now or wait for cost-budget plan?
- [x] File claims of speed/cost in README before measurement? No. — decided: promotion stays on the "verification, not speed" framing until Phase 5 produces measured numbers — checked 2026-11-16
- [ ] Fold any of the 2026-11-13 ideas into phases now, or leave parked?

## Known-state open defects and unknowns (not milestones — fact)

- [ ] Live dispatch of the observer fix on the founder's host — founder's call (requires re-running `setup`; the stdio handshake only validates the wire, not a live dispatch)
- [ ] Wildcard deny on wire-level on this host — scratch-verified at config-build layer; never dispatched
- [ ] Budget-exhausted fix — shipped in **1.0.9** on npm; live install on the founder's host still behind setup's pending restart

## Team mode (2026-11-16) — sharp edges found during the build

- [x] Bare `/cubicore:execute` in a team directory — N remains optional, dispatch proceeds on the fallback file (member 1 / base), and the reply discloses which file it picked plus how members 2..N dispatch their own slices; lone `_1` fallback prints nothing (2026-11-17)
- [x] Cross-plan validator includes the base plan in collision and interface scans when members exist (validate-both shipped 2026-11-17); mixed directories no longer dispatch an unchecked base against members
- [x] Contract ids shared between member plans — memberContractIdCollisions() scan at plan-write time; shared ids named in the reply; member MD withholds progress markers for collided ids rather than rendering another member's checks; both write paths (plan_write and record_factory_fit) honor it — checked 2026-11-16 (base .cubicore-progress.json write side deliberately untouched)
- [ ] Team-mode note on "Archive of plan-and-run context" above: member files (`CUBICORE_PLAN_N.md` × N, `CONTEXT_N.md` × N) multiply the archaeology problem — the archive item matters more after 2026-11-16, not less.


## 2026-11-16 — benchmark capture shipped; Phase 5 runs remain unscheduled

- [ ] Benchmark runs — arms defined (one-agent vs cubicore, session dispatch for measurable tokens), holdout unpicked, N unset; needs the founder's tokens and calendar; Phase 5 remains closed until then


## 2026-11-16 — planner risk review shipped; still open

- [ ] Associates still run unrestricted shell — sandboxed associate execution (bwrap/firejail/sandbox-exec) is the real fix and needs the founder's call on host privileges
- [ ] verifyModel probes both route families but this host still returns HTML 200 on /provider-ish routes and 401 on /api/* with the service.json credentials — find the host's actual route/credentials or accept loud-unverified as the steady state (founder's call)
- [ ] Wildcard MCP deny — wire-level verification on this host remains unconfirmed (founder's call)
- [x] Release drift — setup now backs up the pre-write config to `.cubicore-backup-<ts>` before overwriting and writes `.cubicore-version` (version + UTC) beside it on every install, no-op included — full release-drift item done 2026-11-16


## 2026-11-17 — evidence seal shipped; still open

- [ ] Evidence seal on this host — never executed against a live Cubicore run yet; every dispatch plan written before 2026-11-17 has no seal on disk and degrades gracefully (nothing enforced, nothing claimed)


## 2026-11-17 — stage-end honesty shipped; still open

- [ ] Evidence seal never executed against a live Cubicore run yet — verification still surfaced only on freshly-accepted plans going forward; the first live render is the next one
- [ ] The visual verdict was never fed to a founder interactively; the preview wiring exists but the loop "ask the founder to look before deploy" has not happened across any published build


## 2026-11-17 — DX ranking shipped; next candidates to weigh, in order

- [ ] `/preview` — a model-viewed rendered image + explicit "user happiness" line (blocked by exposing image attachment in the host agent — needs the host session to attach the screenshot)
- [x] integration required for `plan-full` — 2026-11-24: loud advisory in the execute verdict, never a blocker
- [ ] Visual check as blocking gate — refused; developer intent decides before shipping


## 2026-11-18 — DX items 1, 2, 4 shipped

- [x] Streaming preview lines + #2 failure kind classifier + #4 port-in-use guard


## 2026-11-18 — DX #7 done; rationing next items honestly

- [x] CUBICORE_DEBUG.md restructured into Verified/Blocked/Escapes — 2026-11-18
- [ ] Structured escapes section manually populated at verify seam (needs aggregation hook into debug rite, a bigger change — ask first)


## 2026-11-18 — Token audits still open

- [ ] PLANNER_PROMPT (schema.ts) and renderPlanPrompt (server.ts) — same treatment — the next biggest token sinks per planner call
- [ ] .cubicore-factory-ledger.json + .cubicore-factory-history.jsonl — production MD output; words the user reads are paid once per run


## 2026-11-19 — `.cubicore-state.json` shipped; the live use of it still pending

- [x] `.cubicore-state.json` introspection and write — done 2026-11-19
- [x] Wire host reality from `.cubicore-state.json` into associate briefs — 2026-11-24: read-only hint appended to each worker brief
- [ ] Estimate p50/p75 from history (DX #5) — not started
- [x] doctor command — 2026-11-26: read-only host/project diagnosis, live scratch session probe, no secrets printed
- [ ] Phase 3 groundwork shipped 2026-11-26: host registry with real config paths and declared limits (Claude Code, Codex CLI); no runtime adapters yet

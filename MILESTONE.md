# Milestone

Completed items were moved to `docs/archive/completed-milestones.md` on
2026-11-09; this document carries only unfinished work.


## Landscape: inline sub-tasks vs sessions

Surveyed across the coding agents Cubicore could plausibly target.

| Agent | Inline sub-tasks | Sessions / worktrees | Primary interface |
|---|---|---|---|
| Claude Code | ✅ | ✅ | Terminal CLI; transient sub-agents, native git isolation, MCP |
| OpenAI Codex | ✅ | ✅ | Terminal / API; sandboxed cloud, ephemeral session ids |
| Cursor | ❌ | ✅ | AI-native IDE; parallel editor states, cloud sessions, MCP |
| Windsurf | ✅ | ✅ | AI IDE (Cascade); sub-agent tracking, git worktrees, MCP |
| Devin | ❌ | ✅ | Autonomous; isolated containerised VMs, async tickets |
| Replit Agent | ❌ | ✅ | Cloud IDE; persistent multiplayer workspaces |
| Cline / Roo Code | ❌ | ✅ | VS Code extension; one persistent session, external plugins, MCP |
| Aider | ❌ | ✅ | Git-first CLI; commits as sessions |
| OpenCode | ✅ | ✅ | Open-source TUI; task delegation and modular session workspaces |

**Sessions: 9 of 9. Inline sub-tasks: 4 of 9.**

That asymmetry drives the priority order.

## Priority 1 — inline sub-tasks

Available in Claude Code, Codex, Windsurf and opencode: the four agents most
worth targeting, and the ones whose users expect to watch work happen.

Why it leads:

- **Immediacy.** A 366-second opaque tool call is indistinguishable from a
  hang. Observed repeatedly in live runs — work landed, nothing returned.
- **It is the host's own affordance.** We would render through a mechanism
  users already understand rather than one Cubicore invents.
- **It aligns with D7.** Aggregators read artifacts, not transcripts. The
  transcripts were never the point; defending sessions as an audit trail
  contradicted a decision already made.

## Priority 2 — sessions

Universal (9 of 9), so this is the portable primitive and the portability
story. Retained because it provides what inline cannot:

- post-hoc inspection of what an associate actually did
- independent cancellation and per-contract wall-clock tracking
- a durable record across process restarts

Sessions are what opencode's platform shape pushed us toward initially, and
they work. They are the fallback, not the destination.

## Both

The four leading agents support both. They are complementary, not competing:

| Need | Mechanism |
|---|---|
| See work as it happens | Inline sub-task |
| Audit afterwards | Session |
| Cancel one associate | Session |
| Enforce disjoint writes | Either |
| Gate the result | Either |

Cubicore's contract layer, gates, budgets and refusal logic sit above both and
are unaffected by the choice.

## Dynamic Multi-Agent Factory — the missing product layer

Cubicore should not be a fancier way to spawn agents. A factory is a system
that first decides whether the work deserves a factory, then creates the
smallest effective team, runs a real lifecycle, integrates the result, verifies
it, and records enough evidence to prove the work was worth splitting.

The important rule:

> **Before dispatching anything, Cubicore must automatically decide whether
> the task deserves a factory, how large the factory should be, and why.**

It must not fan out because it can. It must refuse a factory when one agent is
cheaper or safer, choose a small factory when parallel work is real, and say
why it made that choice.

### The pre-dispatch factory-fit decision

Every plan gets a machine-readable `factoryFit` assessment before dispatch.
The founder sees the conclusion and the evidence; the machine keeps the full
record in `CUBICORE_PLAN.md` and `.cubicore-factory-fit.json`.

The decision asks:

- **Does this task contain genuinely independent slices?** If not, a factory
  adds coordination cost without creating useful parallelism.
- **How many slices are safe to run at once?** Worker count is derived from
  write-scope disjointness and dependency shape, not from the size of the
  prompt.
- **What topology is forced by the coupling?** Fan-out, sequential pipeline,
  shared-core/single-reader, or refusal are all valid outcomes.
- **Is the acceptance criteria machine-checkable?** If not, the project needs
  clarification or one agent, not a team guessing in parallel.
- **Does the expected saving beat orchestration overhead?** If planning,
  dispatch, gates and aggregation cost more than the split saves, Cubicore
  must skip the factory.
- **Can the host actually dispatch the team it wants?** Inline sub-agents,
  sessions, worktrees, permissions and tool availability are checked, not
  assumed.
- **Is the task already 70% finished?** A large task is not automatically a
  factory candidate; remaining work matters more than total ambition.

The outcome is one of:

| Decision | Meaning |
|---|---|
| `single-agent` | One agent is the best factory; do not split it |
| `small-factory` | 2–3 workers, usually one dependency wave |
| `standard-factory` | 4–8 workers, multiple disjoint contracts |
| `pipeline` | Work must be staged; parallelism is limited by dependencies |
| `single-reader` | One worker reads shared context, the rest consume its findings |
| `refuse` | The task is too coupled or under-specified to split safely |

Every decision includes:

1. **Team size** — exact number of associates and why that number.
2. **Topology** — fan-out, pipeline, single-reader, refuse, or single-agent.
3. **Why** — the evidence: independent files, disjoint scopes, checkable
   contracts, estimated wall/token cost, host capabilities.
4. **Why not more workers** — the explicit reason the next worker would not
   pay for itself.
5. **Confidence** — high, medium or low. Low confidence means fewer workers,
   not more.

If the assessment is uncertain, Cubicore must choose the cheaper option. A
wrong factory is not merely expensive; it makes the user wait for coordination
to ruin a job one agent could have done.

### The five outcomes

These are the product outcomes, not implementation details.

| Outcome | What it means |
|---|---|
| **Dynamic Decision-Making** | Team size, topology, refusal and escalation are decided from the task and the host before dispatch, and can change during the run |
| **Real Agent-Factory Behaviour** | Cubicore has factory states, controlled handoffs, work queues, integration, retrospective and archive — not just parallel task calls |
| **Host Portability** | The same factory contract maps onto OpenCode, Claude Code, Codex, Cursor, Windsurf and session-only hosts, with graceful degradation |
| **User-Visible Value** | The founder can see what is happening, why it is happening, what each associate owns, what is blocked, and what to do next — without reading transcripts |
| **Proof That It Works** | Reproducible benchmarks show time, cost, defects, collisions and completion rate versus a single agent and a naive fan-out |

### The twelve concrete improvements

#### 1. Make team creation genuinely dynamic — **done (2026-11-09)**

Team size is computed from the task's dependency graph and host capability:

- zero worker: the task is refused
- one worker: one agent does the whole job
- two or more: only if the slices are independent and checks exist
- shared core: one reader produces a findings artifact; others consume it
- coupled/unclear work: sequential pipeline or refusal

The founder can override the number, but the default must be justified, never
maximal. The plan records the factory budget: workers, waves, wall clock,
tokens, check runs, and the cost of the orchestration itself.

#### 2. Make roles more than labels

`backend`, `frontend` and `test-writer` are not roles. A factory role is:

- a bounded write scope
- a capability set and tool policy
- budget and retry limits
- required handoff artifacts
- checks that decide acceptance
- exclusions and escalation rules

Roles may be composed and restricted, but never given a name instead of a
contract. The host receives the role's exact authority, not an honorific.

#### 3. Add a real factory lifecycle

The current dispatch is a one-shot fan-out. A factory needs an explicit state
machine:

`intent → factory fit → plan → team proposal → dispatch → observe → integrate
→ verify → retrospect → archive`

Each state has an entry condition, an exit condition, a responsible owner and
a durable record. A worker that reports blocked moves to `escalated`, not into
an unbounded retry. A failed gate moves the contract back to a narrower
revision. A passing gate moves it to `ready-to-integrate`; it never means
"merge whatever changed."

#### 4. Improve automatic integration

Parallel workers do not need to touch each other's files, but their work
still has to become one product. Cubicore needs:

- an explicit integration contract before dispatch;
- a single integrator role or a post-dispatch integration wave;
- mechanical interface checks between contract outputs;
- collision detection against actual changed files, not just declared writes;
- conflict reports that distinguish scope violations from real merge conflicts;
- an integration smoke test before the project is declared runnable;
- a rollback path when integration fails.

The factory does not silently concatenate reports. It composes the result and
proves the composition works.

#### 5. Add adaptive execution

A factory must change course when the facts change:

- split a blocked contract into smaller contracts;
- merge two workers that discovered they own the same file;
- stop a worker whose check fails for an environmental reason;
- skip or re-sequence work when an earlier gate disproves the plan;
- replace an unavailable host capability with the strongest available one;
- stop spending when the remaining work is cheaper as one agent.

Adaptation is bounded by budgets and recorded as a decision. It is not licence
to re-plan endlessly.

#### 6. Build a proper host-adapter layer

Cubicore needs one factory contract and many host adapters. The adapter
answers the same questions everywhere:

- Can this host dispatch inline sub-agents?
- Can it create child sessions?
- Does it isolate worktrees or containers?
- Can it enforce tool and filesystem permissions?
- Can it stream lifecycle events honestly?
- Can it cancel a worker?
- What does the host need written in its own config versus its plugin?

OpenCode remains the reference host. Claude Code and Codex adapters should be
next because their users already expect sub-agents. Cursor, Windsurf and
session-only hosts degrade to the same contract through sessions. Unsupported
capabilities are reported, not silently emulated.

#### 7. Make MCP more automatic

The MCP should be a factory operator, not a command manual:

- discover the project and the host;
- assess factory fit;
- choose the factory;
- write briefs;
- dispatch what it is allowed to dispatch;
- observe, gate, integrate and verify;
- choose the next useful action from persisted state;
- report only when done or blocked.

If the host cannot perform an action itself, the MCP returns the exact next
operation instead of pretending it happened.

#### 8. Add a factory dashboard or readable status

The founder does not want a wall of tool calls. They want an honest picture:

- factory decision: why this many workers;
- current phase: fit, planning, dispatch, integration, verification;
- each worker: owner, scope, state, last check, blocker;
- queue: waiting, running, blocked, done, failed;
- integration status and the checks that failed;
- next action and who can perform it;
- a single `Done / Blocked` verdict at the end;
- a link or path to the factory ledger and artifacts.

The dashboard reads persisted state, so it survives a restart. It is a
status surface, not a second plan.

#### 9. Add a factory-fit assessment — **done (2026-11-09)**

This is the gate before everything. It is both automatic and inspectable.

It estimates independent slices, coupling, checkability, host support, worker
count, expected wall/token cost, and risk. It returns a decision and the
reason. It must be able to conclude:

- "one agent is enough";
- "three workers are enough and why";
- "this is not decomposable without a shared-core reader";
- "not enough acceptance criteria; clarify first";
- "factory cost exceeds the expected benefit; single agent."

A large prompt alone never qualifies.

#### 10. Improve continuous-project support

Cubicore is a factory for one-off projects and for projects that live through
many change cycles. It needs:

- an initial baseline and per-run delta;
- preservation of previously-green contracts;
- regression checks after every cycle;
- incremental briefs for additions and removals;
- a rolling ledger of decisions, findings and fixes;
- stable IDs that survive plan rewrites;
- a cycle budget that stops after unproductive loops;
- an explicit answer to "what did this cycle improve?"

The proof is a 20-feature project over repeated runs, not one heroic build.

#### 11. Measure the claims (blocked / demoted)

Publishing a Cubicore speed or cost benchmark is not on the cards in the near
term. Nothing has been measured on the opencode v2 host; benchmarks are
harness-correctness tools only. Until a measurement exists, the README and
this document make no cost or speed claim. If one is ever produced, it must
survive an identical task on the same host and model:

- time-to-complete versus one agent;
- token cost versus one agent and naive fan-out;
- check pass rate and escaped defects;
- write-scope collisions caught before dispatch;
- factory-fit decision quality;
- integration failures versus disjointness;
- average time to first useful result;
- founder interventions before done;
- number of accepted versus refused factory recommendations.

The 3D-world reference task remains valuable because it is real. The target
is to beat, or at least not lose badly to, a strong one-agent run. Cubicore
should say what actually happened, including when the factory is not worth it.

#### 12. Prioritized implementation plan

The order below removes the ambiguity: make the current system visibly a
factory first, make it reliable second, portable third, continuous fourth, and
proven fifth. Phase 1 shipped (archived in `docs/archive/completed-milestones.md`);
Phase 2 is next.

### Phase 2 — Strengthen runtime behaviour

Scope:

- Explicit lifecycle states and legal transitions.
- Roles with capabilities, tool restrictions and budgets.
- Integration contract and integration wave.
- Conflict and collision reporting from actual diffs.
- Adaptive split/merge/skip/escalate decisions.
- Real retry limits and `unfixable` outcomes.
- Better cancellation and resume semantics.
- Factory dashboard/status ledger with all worker states.

Exit criteria:

- a blocked contract changes the plan safely;
- a bad check is distinguished from bad code;
- an integration failure is caught before hand-off;
- a run can be cancelled, resumed and audited;
- the founder never sees six agents all editing the same file.

### Phase 3 — Improve portability

Scope:

- Host adapter interface and capability negotiation.
- OpenCode reference adapter.
- Claude Code and Codex adapters.
- Session fallback for hosts without inline sub-agents.
- Config-first agent registration and host-specific doctor checks.
- Cross-host smoke suite: plan → dispatch → gate → integrate → verify.

Exit criteria:

- one factory plan can run on at least three hosts;
- missing host features are reported accurately;
- no silent fallback to a different execution model;
- adapters declare limits instead of faking capabilities.

### Phase 4 — Support continuous projects

Scope:

- Incremental plans over existing projects.
- Delta briefs and stable contract IDs.
- Preserve green work; re-run only affected contracts.
- Regression ledger and change-impact report.
- Repeated-cycle benchmark on a living codebase.

Exit criteria:

- a twenty-change project can run repeated cycles without resetting;
- previously-green work survives unrelated changes;
- regression failures are localised and attributable;
- every cycle leaves the project more verified than before.

### Phase 5 — Prove the value

Scope:

- Define the public benchmark set: 3D world, API, CLI, migration, bugfix.
- Compare one agent, naive fan-out and Cubicore on identical inputs.
- Publish time, tokens, defects and founder interventions.
- Hold out tasks so tuning does not overfit benchmarks.
- Turn results into advertised claims; delete claims that fail.

Exit criteria:

- the reference task beats or approaches the one-agent result;
- Cubicore's token saving is reproduced, not anecdotal;
- the factory-fit decision predicts when fan-out pays;
- the user gets a finished result with less supervision, or the benchmark
  says so honestly.

### Priority rationale

Phase 1 shipped; Phase 2 follows because a factory that decides correctly but
integrates badly is still not a factory. Phase 3 makes the decision portable.
Phase 4 makes it useful after the first run. Phase 5 is mandatory before
anyone is allowed to call the system proven.

### Definition of factory done

A Cubicore run is factory-complete only when all of this is true:

- factory fit was evaluated and recorded;
- the team was the smallest effective team;
- each worker's scope did not overlap;
- integration passed its own checks;
- the delivered result was actually run or verified;
- the founder received a concise done/blocked verdict;
- the ledger records why the factory was or was not worth it;
- the benchmark or project ledger can show the value claimed.

### What not to build yet

- dozens of agents for every task;
- silent automatic merges;
- a dashboard before the ledger is correct;
- cross-host support based on guessed capability names;
- adding workers to compensate for an unclear plan;
- claims of speed or quality before measurement;
- "smart" re-planning that spends more than the project.

## What this does not change

The enforcement layer is portable either way: validation, the check matrix,
gating, budget caps, topology. Only orchestration moves.

**Open question carried forward:** under inline dispatch, `settledUsage` has no
associate session rows to read, so the cost claim loses its current source.
That must be resolved before the orchestrated benchmark arm can report X and Y.

## Platform behaviours worth recording

- **`body.agent` on `session.prompt` is accepted and silently ignored.** An
  unknown agent name falls back to `build` with no error. This cost four
  benchmark cycles before it was found, and it is why the associate is now
  created as a session child rather than selected by name.
- **`client.event.subscribe` yields only `server.connected` and
  `server.heartbeat`.** It never carries `session.idle`, so a dispatch built
  on it waits out every worker's full wall budget and reports nothing. The
  raw SSE endpoint carries the session lifecycle.
- **A plugin's `config` hook may not be applied in every host instance.**
  The hook ran, the plugin loaded without error, and yet the mutation was
  absent from `/config` and the agent from `/agent`. Anything a host
  *requires* should live in the host's own config file, not behind a hook.
- **A model removed from the provider fails silently.** The prompt is
  accepted, the user message is recorded, and no assistant reply ever
  arrives -- no error anywhere. Every associate then sits idle until its
  wall budget expires, which reads as a slow model.
- **An opencode server binds an ephemeral port.** Identifying it by
  listening position picks the print spooler; it has to be matched by owning
  process.

## The first complete run

A seven-contract plan ran to completion in two waves, and the result was
verified three ways: the contract's own checks (21/21), the full suite
(54 tests), and a script written independently of the associates' test
files to confirm the founder's stated behaviours.

What the run proved:

- **Inline sub-tasks render in the host's own UI.** Five `Cubicore-Associate`
  entries appeared in the conversation, each with its brief. That is the
  visibility the session path could not give, and it came from a
  config-registered agent rather than a plugin hook.
- **Stage ordering is real.** Foundation landed, then the five route modules
  together, then the dispatcher, which had to wait because it imports the
  route descriptors at runtime.
- **The plan's own checks were not enough, and the associates said so.** The
  health contract's "uptime is non-decreasing" assertion passes against a
  `Date.now()` implementation, because a real clock does not move backwards
  in an ordinary run. An associate added a test that swaps in a
  backwards-jumping clock, and that is the assertion that actually pins
  monotonicity.
- **Negative testing found a real hang.** Removing the 204 rule made the HTTP
  client wait forever rather than fail, because an exception while writing
  the response left the connection open with no body.

Two defects were Cubicore's, not the associates': the brief could
contradict itself about the files it owns, and the graph budget's edge
ceiling was never checked against the number of edges the plan needed.

## Deferred: making Cubicore faster and cheaper

Recorded, not started. The founder's call was to note the plan and leave it
alone for now.

### What the measurements actually say

The verdict from the last benchmark run is uncomfortable and worth writing
down plainly:

| vs | faster? | cheaper? |
|---|---|---|
| naive fan-out | yes, 2.9× (confounded) | yes, 3.5× (clean) |
| a single agent | no — parity (1.1×) | no — 3.1× more expensive |

Against naive fan-out, Cubicore is both. Against one agent, it is neither:
level on wall clock and three times the cost. That is the honest position,
and the Amdahl ceiling explains it. With planning at ~15% and aggregation at
~10% of baseline, eight workers give `1 / (0.25 + 0.75/8) ≈ 2.9×` — the
ceiling is about three, not eight, and it is raised by making the two serial
phases cheaper, not by adding workers.

The wall-clock half of the 2.9× is confounded and should not be quoted: the
naive arm was capped at three concurrent workers while the orchestrated arm
dispatched all twelve. The token half is clean, because both arms ran the
same twelve workers.

### Where the cost is

A two-worker end-to-end run cost 2.2M tokens — about 1.1M per worker to
write one markdown file. The split was 1,281 input against 2,199,671 cache
read. The work is re-reading context, not producing tokens.

`cubicore-associate` has no `tools` restriction, so every worker inherits the
whole host tool surface: the built-ins, plus every MCP server's schemas —
Cubicore's own sixteen, rea's ~80, github's thirty, playwright's
twenty-five. opencode sends that schema in every request and re-reads it on
every tool-call turn, so it multiplies by turns. This is the suspected
primary cause and it has not yet been measured.

### The plan, in order

1. **Instrument the context.** Print the tool-schema block size for the
   associate and for the Main agent. Cheap and decisive — it either confirms
   the hypothesis or kills it before any optimisation happens.
2. **Restrict the associate's tools.** Keep `read, write, edit, bash, grep,
   glob, list, patch`; deny `webfetch, websearch, task` and wildcard-deny the
   MCP servers. opencode 1.18.29 supports per-agent `tools` with server
   wildcards, so `"rea*": false` is the shape. The associate needs no MCP
   server, but the host hands it every one. *Verify the wildcard matches; a
   miss is silent.*
3. **Lean the brief.** Every read is a turn and every turn re-reads the
   prefix. Give the worker its exact file list, its exact check command and
   its exact report format, to do read → edit → verify → report in the fewest
   turns possible.
4. **Fix the lying trace and make cancel real.** `client.session.prompt` is
   called without streaming, so it blocks for the whole turn — which is why
   `worker.prompted` fires 76 seconds late. It is really "turn finished". The
   event stream already knows when a worker goes idle, so the call is
   redundant. Streaming gives honest progress and lets `cancel` interrupt a
   turn instead of waiting out the wall budget.
5. **Add the concurrency cap.** `dispatch` runs a whole topological stage
   under `Promise.all` with no cap. That is the load-70 problem, and the
   reason the fair comparison could not be run as written.
6. **Then measure, once.** A/B the same task with and without the restricted
   tools. Do not run the benchmark before the cheap wins — measuring now
   means measuring the wrong thing twice.

### Not planned, but the only real answer

The single-reader topology (D7) is the one mechanism that reduces total
tokens *below* a single agent: one worker reads the shared context and writes
a findings file, the rest read that instead of the repository. It is a design
change rather than a tweak, so it waits for 1–5 and their measurements.

### One thing this exposes about the product

Step 2 is a host-configuration change as much as a code change. Those MCP
servers are in the host's config, and the Main agent pays for them too — part
of Cubicore's cost is not Cubicore's, it is the tool surface the host hands
to every agent. If the restriction works, the installer should recommend the
same lean profile for the Main agent.

## Deferred: a speed and cost budget for every step

Recorded, not started. This is the per-procedure breakdown of the plan above:
what each step of the pipeline costs, what makes it slow, and what would make
it faster or cheaper. It exists because the earlier note concentrated on one
hypothesis (worker context) and a per-step view is what actually decides where
to spend effort.

The two currencies are different and get confused. **Tokens** are dominated by
context re-reads; **wall clock** is dominated by the serial phases. A change
that helps one can do nothing for the other, so they are listed separately.

### Where the pipeline spends

| Step | Serial? | Token cost | Wall clock | The improvement |
|---|---|---|---|---|
| `prepare` | yes | none | one `git add -A` + commit | already idempotent; a baseline only needs writing once |
| `research` | yes | one Main-agent turn | one tree walk | cache the survey per directory; a re-plan should not re-walk |
| `plan` | **yes** | one Main-agent turn + the plan schema | the largest serial phase | let the tool fill in the mechanical parts of the plan |
| `execute` — worktrees | no | none | N × 3 git subprocesses | scope the checkout to the files a contract owns |
| `execute` — workers | no | **the whole bill** | the parallel phase | the tool restriction, above |
| `execute` — gates | no | none | N check commands | dedupe identical commands |
| `execute` — collect | no | none | N × git read | scope the read to the contract's own paths |
| `debug` | no | none | N check commands | dedupe identical commands |
| `preview` | yes | none | one run | keeps it running |
| `aggregate` | **yes** | one Main-agent turn | the second serial phase | aggregate machine-readable artifacts mechanically |
| `status` | no | none | one read | fine as it is |

### The serial half is the ceiling

Planning and aggregation run one-at-a-time and do not shrink, so they set the
Amdahl limit: `1 / (0.25 + 0.75/8) ≈ 2.9×` for eight workers. The ceiling is
raised by making the serial phases cheaper, not by adding workers. Every
improvement below that touches the parallel phase is worth less than it looks.

**`plan` is the expensive one.** The Main agent hand-writes the whole plan
JSON, and the tool then rejects it if the shape is wrong. A rejected plan can
cost three full Main-agent turns before the attempt cap stops it, and each
turn carries the whole host tool surface. The improvement is to let the tool
derive the mechanical parts — contract ids, `graphBudget` defaults, the
baseline check union, the dependency edges implied by the writes — and ask
the Main agent only for what needs judgement: objectives, write scopes, and
the checks that are not derivable. Less output from the agent, fewer schema
drifts, and a rejected plan becomes a fix rather than a rewrite.

**`aggregate` is the one that grows.** It reads every artifact into one
context. If the artifacts are machine-readable, a mechanical aggregator is
strictly better and the Main agent is only needed for prose. If the artifacts
are prose, the growth is inherent — which is what the single-reader topology
is for.

### The parallel half, where the tokens are

99.9% of a measured run's tokens were cache reads, not input. Two causes, and
both multiply by the number of tool-call turns a worker takes:

1. **The tool schema.** Every worker carries the host's whole tool surface.
   This is the restriction already described above.
2. **The number of turns.** Every read, edit and command is a turn, and each
   turn re-reads the prefix. A leaner brief — exact file list, exact check
   command, exact report format — buys turns directly.

### The worktree tax, which nobody has costed

Isolation currently costs three git subprocesses per contract: add, read back
the diff, remove. For twelve contracts that is thirty-six git invocations,
and `git worktree add` contends on the repository's index lock, so they
serialise against each other.

More importantly, each worktree is a **full checkout of the whole repository**.
For a contract that owns one file, that is absurd. A scoped copy of the
paths a contract owns would be far cheaper — and would not contend on any
lock. The check is whether the scope check still works, which it does if the
copy is the contract's own tree.

### Checks are run more often than they need to be

Every contract names a check, and two contracts naming the same command means
that command runs twice. The gate matrix is a union computed at validation
time, so identical commands are already known — they just are not deduped at
run time. One full test suite run per distinct command, not per contract.

### The honest summary of expected effect

The tool restriction is the largest single lever and is unmeasured. The
worktree scoping and the check dedupe are smaller but reliable. The plan and
aggregate changes are the ones that move the ceiling rather than the
constant, and they are the most invasive.

None of this is worth measuring before the cheap wins land. Measure once,
after.

## Known state

- Plugin and MCP front-ends dispatch, gate and report a verdict
- `execute` returns the final verdict rather than a run handle; `continue` behaves likewise
- Debug combines review, checks and fixing in a bounded loop; `preview` leaves the delivered thing running
- Disjoint writes verified by digest on a real four-associate run
- Executable checks caught two defective planner fixtures
- UI-capable plans require a design block (direction, palette 2–4 hex, typeface, notDoing, ambition); a UI plan without one is rejected before dispatch. `gateStyle` rejects every hex in the diff that is not in the declared palette. A contrast ≥ 4.5:1 check guards body text.
- Factory-fit pre-dispatch decision is computed at plan time, printed to the founder, attached to the plan, and enforced at execute time: a `single-agent` decision dispatches one associate, not N. `.cubicore-factory-fit.json` records the decision; `.cubicore-factory-ledger.json` records what happened (fit, outcome, tokens, cost).
- Factory-fit assessment is shipped; lifecycle state machine, dashboard and host adapters are product work, not shipped behaviour
- Factory-fit verified live (2-associate smoke, 2026-11-09): form delivered to the founder's session, founder answered via the form, dispatch honored the recorded decision, both doneWhen checks passed on disk. The v2 host will not place an associate session in a per-worker worktree (directory is ignored), so the scope gate flags shared-tree fan-out as violations; the founder-approved fix direction is the union-scope gate (not implemented)
- Factory ledger shows zero tokens on this host; telemetry now picks the database with the newest session rows (unverified until the next live run)
- Corpus plans for the benchmark do not exist yet; the 3D-world reference is unmeasured
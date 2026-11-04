# Milestone

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

- Plugin and MCP front-ends both dispatch, gate and report a verdict
- `execute` returns a run handle; `status` polls — timeouts no longer lose a verdict
- Disjoint writes verified by digest on a real four-associate run
- Executable checks caught two defective planner fixtures
- Corpus plans for the benchmark do not exist yet; X and Y are unmeasured
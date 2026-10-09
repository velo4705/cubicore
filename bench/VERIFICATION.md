# Verification log

Assumptions that were documented as guesses, checked against
`@opencode-ai/plugin@1.18.35` and `@opencode-ai/sdk@1.18.35`.

## Confirmed correct

| Assumption | Status |
|---|---|
| `chat.params` output has a mutable `maxOutputTokens` | **Correct.** Hard cap works. |
| `session.abort({ path: { id } })` exists (`POST /session/{id}/abort`) | **Correct.** Wall-clock overrun is a real stop. |
| Token block is `{ input, output, reasoning, cache: { read, write } }` | **Correct** (verified earlier against the session DB). |
| `cost` is a sibling of `tokens` on the message | **Correct.** |
| `role` is a plain string in storage | **Correct** — and the original adapter missed this, which would have counted user messages. |
| `session.create` / `session.prompt` / `session.diff` exist | **Correct.** |

## Corrected

| Assumption | Reality | Fix |
|---|---|---|
| `tool.execute.before` can deny a call | **It cannot.** Output is `{ args: any }` — there is no `status` field, unlike `permission.ask` which does have one. | The tool-call cap is **advisory**: the overrun is counted and reported, but the call still runs. `applyDenial` writing `output.status` is dead code. |
| Session cancellation might not exist | **It does.** `session.abort`, returns `200: boolean`. | `SessionSpawner.cancel` is implemented for real. |

The veto finding is the significant one: **opencode has no hook that can stop a
tool call.** So the only hard budget control available to a plugin is
`maxOutputTokens`. Tool-call caps can be observed and reported but not enforced.
This is a platform limit, not an implementation gap.

## Platform surface worth recording

Available to a plugin:

- `session.create` / `prompt` / `promptAsync` / `abort` / `diff` / `children`
- `config` hook — inject agents, commands, MCP servers
- `tool` hook — register custom tools (`{ description, args, execute }`)
- `event` hook — every bus event, including `message.updated`,
  `message.part.updated`, `file.edited`, `session.idle`, `session.error`
- `chat.params` — mutable `maxOutputTokens` (the one hard cap)
- `tool.execute.before` — mutable `args` only, **no veto**

Not available:

- Cancelling an individual tool call
- Any budget- or count-based enforcement — permissions are pattern-matched, not
  counted, so a "deny after N calls" rule cannot be expressed in config

## Live-server findings

Checked against `opencode serve` on 1.18.35, in isolation.

### Live events report zero usage — the database is the only source of truth

A session created and run against a live server:

| Source | input | output |
|---|---|---|
| `message.updated` event, every occurrence | **0** | 0 |
| session row in the database | **34,539** | 3 |

The event carries a correctly-shaped `tokens` block with zeros in it. Real
totals are only persisted afterwards.

**Consequence:** anything fed from the event bus — `RunObserver.usage` and the
plugin's `UsageLedger` — **is not a cost measurement and currently reports zero.**
`bench/tokens.ts` is the only accurate reader found. The plugin's cost reporting
is wrong until it reads the session row after each run.

### `message.part.updated` carries no role

The event looks identical for a user prompt and an assistant reply:

```
MSG  id=msg_...  role="user"
PART messageID=msg_...  text="Say PLANOK"      <-- the user's own prompt
MSG  id=msg_...  role="assistant"
PART messageID=msg_...  text="PLANOK"          <-- the actual reply
```

A `RunObserver` that filters only on `part.type === "text"` returns the prompt
concatenated with the reply. For the coordinator that is fatal — the planner
returns its own prompt plus the plan, which never parses.

Fixed: `RunObserver` records assistant message ids from `message.updated` and
only accepts text parts whose `messageID` belongs to one. Verified in isolation:
`texts: ["PLANOK"]`.

### Text arrives twice

Assistant text streams via `message.part.delta` events and then arrives whole
again on a `message.part.updated`. There is also an initial `text=""` part. The
observer keys by `part.id` and overwrites, so streaming updates replace their own
earlier value rather than appending duplicates.

### Auth

`opencode serve` reads `OPENCODE_SERVER_PASSWORD` and returns **401 with an empty
body**, which the SDK surfaces as an undefined `data` rather than an exception.
Easy to misread as a measurement failure. The SDK client also needs an explicit
`baseUrl`; `directory` alone is not enough.

## Still broken

The `orchestrated` arm does not complete. With the text bug fixed it still ran
past seven minutes without returning, which points at the dispatch stage rather
than the coordinator. Not yet isolated.

X and Y remain unmeasured.

1. **Output-token cap is the only hard control.** It matters more than
   originally assumed, and it is the highest-leverage budget mechanism in the
   system.
2. **Tool-call caps are observability, not enforcement.** They still earn their
   place — the report tells you a worker was thrashing — but the code should not
   imply they stopped anything.
3. **`session.diff` gives changed files authoritatively**, so the `file.edited`
   guess in `observe.ts` is a fallback rather than a dependency.
### The orchestrated arm: coordinator returns nothing

With stage tracing enabled (`trace` on `producePlan` / `dispatch` /
`WorkerSessions`), one run shows the whole failure:

```
[      5ms] attempt.start     {"attempt":1,"promptChars":3381}
[ 221239ms] attempt.prompted  {"attempt":1,"ms":221234,"rawChars":0}
[ 221240ms] attempt.malformed {"attempt":1,"problems":1}
[ 221240ms] attempt.start     {"attempt":2,"promptChars":356}
```

- The coordinator takes the **full 180 s deadline** and returns **zero
  characters**. It is not slow — it is *empty*.
- `rawChars: 0` is then correctly rejected as malformed, and the re-plan prompt
  is only 356 chars because it carries findings instead of the schema.
- Reproduced on **both** `opencode/space-bunny-free` and `opencode/big-pickle`,
  so this is not model latency.

The 402 s figure from the earlier run is now fully explained: 180 s deadline ×
2 attempts + overhead, with neither attempt producing output.

**What was wrong in earlier guesses.** Event wiring was a real bug and is fixed,
but it was never the hang — the run never reached dispatch. Two hypotheses
before this one (dispatch stall, then model latency) were both wrong; the trace
settled it in a single run.

**Open question.** Whether the coordinator returns empty because the 3,381-char
planner prompt exceeds what this model will answer, because the session errors,
or because the observer is missing assistant text in this code path — an isolated
`RunObserver` test does capture text, so the difference is not yet explained.

### The coordinator echoes its prompt and ignores `tools`

After disabling every tool via `SessionPromptData.body.tools`, the session still
ran six assistant turns with `tool` parts present, and the only text part was:

```
"The previous plan was rejected. Here are the validation findings:\n\n- ["
```

That is the **opening of `REPLAN_PROMPT` verbatim** — the model is echoing the
prompt back rather than answering it.

So on this endpoint the coordinator is unreliable as a structured-output emitter:
- with tools enabled it explores the repo (30–80 turns, ~47k tokens, prose)
- with tools disabled it still emits `tool` parts and echoes the prompt

Both models (`space-bunny-free`, `big-pickle`) behave the same way.

**What this rules out.** The coordinator cannot be a normal opencode agent
session that happens to be told to emit JSON. It needs either a genuinely
non-agentic completion call or a structured-output parameter. `SessionPromptData`
exposes neither, so on this opencode version the coordinator path needs
rethinking rather than more debugging.

**Standing conclusion.** X and Y remain unmeasured. The `single` and
`naive-fanout` arms work; the `orchestrated` arm has never completed.

### Why the named planner agent was ignored

After registering `cubicore-planner` in the scratch repo's `opencode.json` and
passing `body.agent = "cubicore-planner"`, the session still ran as **`build`**
on every message, produced eight turns, and returned nothing usable.

Root cause: `opencode serve` was launched from the Cubicore repository, not from
the scratch repo. `directory` scopes *sessions*, but agent configuration is read
from the **server's project root**. The scratch repo's `opencode.json` was never
loaded, so the agent did not exist and opencode fell back to the default.

Fix: start the server from the directory whose config defines the agent, or
register the agent via the plugin's `config` hook (which is how it ships) rather
than by dropping a file into a scratch repo.

This is a harness setup error, not a design failure. Whether `maxSteps` actually
stops the loop is still unverified — the constrained agent has never once run.

### The coordinator cannot select a subagent — `body.agent` is ignored

Final diagnosis, after four identical failures.

The plugin's `config` hook **works**: with `dist/index.js` loaded via a repo
`opencode.json`, the server lists the agent —

```
GET /agent -> [..., {"name":"cubicore-planner","hidden":true}, ...]
```

Yet a coordinator session created with `session.prompt({ body: { agent:
"cubicore-planner" } })` records **`agent: build` on every message**, in the
`session.agent` column and on each message row.

So `SessionPromptData.body.agent` **does not resolve a subagent by name**. The
value is accepted and silently ignored, and opencode falls back to the default
`build` agent with no error.

**This invalidates the previous four diagnoses.** The tool denial, the
`maxSteps` bound, the named agent, the `NO_TOOLS` body field — all of them were
constraining a session that was never running the agent they were written for.
The coordinator was a `build` agent every single time, which is exactly what
explains: exploring the repo, emitting tool parts, and returning prose.

The signature is silent, which is the real hazard. A wrong model id, a bad tool
name, or an unknown agent all fail the same way — quietly, with plausible
output. Worth asserting on in tests anywhere this API is used.

**Consequence for the design.** The coordinator cannot be an opencode agent
session. It needs either a direct non-agentic provider call or a tool whose
return value is data. Workers are unaffected — they *are* agents, and the agent
model is correct for them.

### What four cycles of this actually cost

Each failure had a confident diagnosis and each was wrong. The distinguishing
evidence was available cheaply the whole time — a database query showing
`agent: build` — and it was not run until the fifth attempt. The lesson is
narrow and specific: **when a mechanism fails identically more than once, verify
the mechanism is running before theorising about it.** I had the exact query
available and chose the more interesting conclusion instead.

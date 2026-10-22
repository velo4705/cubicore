# Cubicore

What if you wished to make a "company" right at home, where you are the founder of the project, and your fellow sub-agents do the work for you?

Enter Cubicore, A Dynamic Multi-Agent Factory System that interacts with Sub-tasks and Sessions (if present). The system is designed as an MCP for enhanced portability across multiple AI agents - Opencode or Claude Code, to name a few.

## What is the idea?

Suppose you imagine a magic "cube", as an example. Act that this cube is a "mini" company that is under your control. Then, you ask the "magic cube" about what you want. It can be anything - even a multimillion SaaS product would be fine. After you reply to the "magic cube", the cube plans and determines the size of your project, and size of your project matters for how many "employees" that will be hired for this job.

Once its all set, the cube resizes and fills it with new "employees" to work on each task the "cube" has been told to provide. It also asks about what style or layout you really want, or maybe you can also ignore it to have the "cube" give the best style it can think of!

The project is done when all sub-tasks are done, but hey, you can even call the testers to test the product you made, just to make sure no bugs, broken interactions, fixable warnings are left behind. You can add any feature you wanted by asking the "magic cube" again, and it will do it for you. It doesn't matter how many decorations you add onto the "magic cube", it will always be better with its "add-ons".

## How it Works?

Like the Idea, Cubicore is the definition of "Cores in a Cubicle", which are called "Cubicores". These "cubicores" represents Inline Sub-tasks or Sessions run by the agent at the same time (it is never one-by-one). 

The Architecture of this idea works like below:

```
[User gives Prompt] --> [Agent Plans about the Prompt and generates file] --> [Summon Sub-agents to read generated file] --> [Submits Result]
```

When a user gives a prompt, assume it to be a simple, lazy prompt "Make me some huge a## project that can make me rich. make no mistakes, i believe in you.".
Using the prompt provided by the User, and Main agent will Plan and research about the project on what you are meaning to build... and will ask further questions about the type of product, the style, the layout, the tech stacks, anything... even the questions would be marked "Recommended" to be selected very easily.
After when its done, it finally determines the Project Size, displays the tasks, where each task (they are no small tasks) is assigned to a particular "cubicore". It also gives out the N number of cubicores required to build your project from scratch. This is all mentioned in the PLAN.md file for every "cubicore", even the "founder" (The user) to see. 

Once done, Hit the "execute" command - The Main agents summon the N "cubicores" as if its constructing an urgent megaproject. These sub-tasks fill in the gaps by finishing its tasks, and avoid conflicts with other workers in the process.

In the end, It finally gives the result you (the founder) wanted. You can try the "test" command to go even further, by asking the Main agent to summon testers for your project, to make sure all broken interactions, and errors, and fixable warnings are recorded in the DEBUG file. Again, anyone is free to see the DEBUG file, as it shows how many problems it has been encountered through the corners of your masterpiece.

After this, Run the "execute" command again, and it starts fixing the issues once again, same procedures as it was. Basically a "rinse-and-repeat" -- with one difference from the original sketch: the loop is **capped at three cycles**. The bound lives in code rather than in a prompt, so it cannot be talked out of. After the cap, the remaining findings are reported as unresolved for a human to triage rather than fixed by another agent that keeps finding new things to complain about.

About the "decorations", Cubicore is meant to have excellent support for plugins and MCPs that can assist the work with new and unique commands running, or possibly reducing tokens along the way. Regardless, it makes the Project even better, and doesnt waste anything.

## Supported AI Agents

Currently, we only support Opencode for now.

| AI Agent | Status | Progress |
|---|---|---|
| Opencode | ✅ | Works end to end — MCP plan/execute/test, inline sub-tasks, sessions |
| Claude Code | 🔶 | MCP is portable; the host-dispatch path is written but unverified |
| Codex | 🔶 | Same MCP surface, unverified |
| Cursor | ❌ | No inline sub-tasks; would use the session path |
| Windsurf | 🔶 | Inline sub-tasks available, unverified |

## Commands

| Command | What it does |
|---|---|
| `/cubicore:plan` | Research the repository, ask what the repo cannot answer, write `CUBICORE_PLAN.md` and `CUBICORE_PLAN.json` |
| `/cubicore:execute` | Write one brief per associate, summon them in parallel, gate each result |
| `/cubicore:test` | Run the mechanical matrix, write `CUBICORE_DEBUG.md` |

## What Cubicore is for

The honest claim, in three parts.

**Splitting work without coordination is not free parallelism.** Measured
against one agent doing the same job, twelve uncoordinated workers cost
**10.9× the tokens and were 2.6× slower**. Every worker loaded the whole
repository into its own context and nothing stopped them colliding.

**Cubicore fixes that.** Against the same twelve-worker fan-out, Cubicore was
**2.9× faster and 3.5× cheaper** — narrower write scopes so each worker reads
less, and gates so the pipeline knows when a worker is finished rather than
guessing.

**But Cubicore does not beat one agent.** On twelve small files it was level
on wall clock and cost 3.1× the tokens. The work was too small to need parallel
workers, and the model was the bottleneck, not the split.

So the value is conditional, and the condition is about the work rather than
about Cubicore:

| Situation | Cubicore is |
|---|---|
| Several hours of genuinely independent work | worth it — 2.9× faster than naive fan-out, 3.5× cheaper |
| A couple of hours, or one sitting | overhead — 3.1× the tokens for parity |
| Coupled work, a shared core, an integration step | refuses it — the topology check catches it before a token is spent |
| One agent, done in one pass | overhead, and the plan says so |

The "9 hours becomes 4" shape is real against the right control, but it is not
"because of splitting". Splitting is what makes the naive version slow. Cubicore
is what makes splitting pay. And the ceiling is below 9→4 for most projects,
because Amdahl's serial fraction does not parallelise and the gates cost
something too.

**And the real value is not speed.** It is that four agents can work on the same
repository without colliding, and that "done" means the checks passed rather
than that a model said so. The speedup is a side effect.

Full numbers and the caveats: [bench/RESULTS.md](bench/RESULTS.md).

## What exists

- **Contracts, not prompts.** Disjoint write scopes, a check matrix computed at
  validation time, budget caps, and a topology check that refuses work which is
  not divide-and-conquer.
- **Two dispatch paths.** Inline sub-tasks where the host supports them, sessions
  where it does not. Both gate the same way.
- **A bounded loop.** `plan → execute → test → execute`, capped at three
  cycles. Not "until the debug file is empty" — that is an unbounded loop whose
  terminal case is an agent that never stops finding things to fix.
- **Judgement never blocks.** Errors and warnings block. "Is this useful" and
  "is this production ready" are recorded as advisory and left to the founder.

## Known limits

- **v1 catches mechanical failures only.** No `judgment` checks are admitted;
  the validator rejects them. Whether a feature is *useful* is not something
  the matrix can decide.
- **Inline dispatch enforces scope after the fact.** A startup hook cannot know
  the contracts, so per-contract permissions are unavailable there. The scope
  gate catches a violation rather than preventing it. The session path prevents.
- **X and Y are unmeasured.** The cost claim has one arm of three. The
  orchestrated benchmark arm now dispatches and gates, but a completed
  three-arm run has not been recorded.
- **Workers get `shell: *`.** Scope violations are detected after the fact.


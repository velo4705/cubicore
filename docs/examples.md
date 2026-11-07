# Lazy prompt examples

No specs, no required format — just what you'd say to a tired founder. The
planner asks what the repo cannot answer, then you review everything.

## Starting fresh

### Demo — build small, ship now

```
/cubicore:plan-demo Make me a todo app that works in the browser
```

Cubicore: prepares (git baseline) → researches the tree → scopes to an MVP →
writes `CUBICORE_PLAN.md` + `CUBICORE_PLAN.json` + `CUBICORE_CONTEXT.md` →
stops. You read the contracts; if something looks wrong, `/cubicore:refine`
it instead of building the wrong thing.

Then: `/cubicore:execute` → `/cubicore:preview` (leave it running) →
`/cubicore:debug` until clean.

### Full product — build it properly

```
/cubicore:plan-full Build me a client portal: client login, project uploads, invoice PDFs, a dashboard
```

Same steps, scoped like production: more contracts, health endpoints, checks
that can fail against real systems. Review before `/cubicore:execute`.

### Build from an idea, not a brief

```
/cubicore:plan-full I want to turn this markdown renderer idea into something usable at work
```

Context is inferred from the repo and the ask. There is no magic — if the repo
can't answer a question, the planner asks you, not the other way around.

## Improving what exists

### Add a feature

```
/cubicore:refine Add CSV export to the finance tracker
```

Contracts that already passed and kept their scopes are not re-run. The cycle
charges you for the change and nothing else.

### Change direction mid-build

```
/cubicore:refine Drop multi-tenancy, single user only
```

Rewrites the remaining contracts to the new shape.

### The plan is off in one area

```
/cubicore:refine The auth contract's write scope is wrong; move middleware to src/auth/
```

No manual file editing — do it through the plan, or the gate will reject the edit.

## When something breaks

### It doesn't work

```
/cubicore:debug
```

Clicks through it like a user, captures console errors and dead commands,
fixes, re-runs, repeats until clean. Writes `CUBICORE_DEBUG.md`.

Or be specific:

```
/cubicore:debug The save button does nothing
```

### It's not what I asked for

```
/cubicore:refine The dashboard shows revenue but I wanted active-project count
```

Fix the plan before another build, don't patch the wreckage — the contract
layer has to know the new shape for the gates to mean anything.

## After the run

### Put it in front of someone

```
/cubicore:preview
```

Runs it the way the founder will use it — web on localhost, CLI output verified,
TUI/GUI verified by its interface. Leaves it running.

### Ship it

```
/cubicore:deploy
```

Two MCQs: which tier, then which stack — each with cost, tradeoffs and the
recommended pick — writes the deploy files, explains the manual steps. Deploys
nothing; it plans.

## Checking work and getting undo

### Is it done? What's running?

```
/cubicore:status
```

### Resume after an interruption

```
/cubicore:continue
```

### Discard it all

```
/cubicore:undo
```

Throws the last execution away, returns the tree to the baseline commit. Says
what it will discard first. Destroy, not undo — use with conviction.

### Just enough to decide

```
/cubicore:estimate
```

What the current plan will cost — associates, token and wall ceilings. Ceilings,
not quotes.

## Team splitting

```
/cubicore:plan-full Build the event dashboard, exactly what we agreed
```

Member A: `/cubicore:execute planNumber 1`
Member B: `/cubicore:execute planNumber 2`
Member C: `/cubicore:execute planNumber 3`

Disjoint scopes, separate worktrees, nothing collides. Resume any of them with
`/cubicore:continue planNumber N` after an interruption.

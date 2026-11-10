# Split-Pass — Design

> **Status: design + first implementation landed.** References to current
> code are accurate as of `2026-11-10`. The size clause is wired into the plan
> prompt (plan-demo and plan-full) as `**Size check**`; the split-pass clause
> is also wired into the same prompt as the mandatory walk-through step before
> passing to the plan tool. The `scale` field is currently only emitted and is
> not parsed (`parsePlan` does not validate it); the schema will need to
> accept it before the next publish. No new gate is planned until a live
> dispatch shows the split to be worth dispatching.

## The problem, in founder's words

"When I ask Cubicore to do a big thing, I get a plan that says 'refactor the
auth layer' as one contract. An associate does not succeed at that — the work
is a week of thinking, not a day of writing code. The plan stays plausible
and the dispatch stays wrong."

What the 1.0.x factory knows today is: **a big request should be broken into
contracts.** What it does not do is notice when a contract that came out of
phase 1 is itself too big, and split it again before the founder reviews.
The dispatch runs the big contract. The associate either underperforms or
gets stuck. Re-running does not help.

## What the founder asked for

> "when you plan a complex prompt, it is split to 3 or 4 contracts, where 1 or
> 2 are still complex. This way, it should split those complex contracts."
>
> "maybe it should let the agent think this user prompt whether it is small,
> medium, large, massive... etc. to complete the exact demonstration, so that
> it plans about splitting into multiple contracts on plan?"

So: the split should be iterative — first-cut contracts that survive phase 1
are walked for sub-divisionability, and the plan is rewritten with the refined
contracts before review. And the planner's size assessment is explicit, not
silent.

## The size clause (small / medium / large / massive)

The plan-full prompt should, **before the first contract is written**, ask the
coordinator to classify the request out loud:

> Before writing any contract, classify the user's request as one of:
>
> - **small** — one to two files, one sitting of work. Unsplit is the right answer.
> - **medium** — a few files, coordinated with some care. A handful of contracts.
> - **large** — many files, clear sub-systems. Probably 4–8 contracts with a real schema.
> - **massive** — multi-crate, multi-engine, open-ended (Minecraft, an OS, a compiler).
>   Needs a staged plan with refusal triggers, not an ambitious guess.
>
> The classification is one sentence in the plan, not a hidden decision. After
> you classify, plan accordingly — the count of contracts you target and the
> shape of the dependency graph must follow from the classification, not only
> from the request.

Classification is an **input** to the split-pass, not a gate. It does not
replace the planner's judgment in the split-pass about which contract is
oversized; the size label tells the planner how ambitious the first cut ought
to be. The split-pass still walks the first-cut output for oversized contracts
— because a single "large" classification can easily produce one contract
that should be much smaller, and because a correct "massive" classification
correctly produces many contracts, of which some will still exceed one sitting.

## Budget honesty rule

A "massive" classification that yields exactly three contracts must have its
reason in the plan. Silent scaling — labeling something massive and then
producing 3 contracts without a documented reason — is not acceptable. The
founder needs to see "team will be small because we refused the ambition you
asked for in that domain." That is also a feature: it surfaces the planner's
limits before the run, not after it fails.

## Non-goals

- No sub-agent-within-sub-agent dispatch (that's a separate question, and
  it's a worse tradeoff cheaper than what we need).
- No runtime splitter at dispatch time. Splitting after work has started is a
  recovery mode, not design — that's a different problem.
- No new schema fields for sub-contracts. A "sub-contract" is just a contract.
- No reason for the dispatcher to know it happened. The union-scope and
  factory-fit already see the refined set.

## Design

### Term

A contract is **complex** if any of these hold:

1. Its `wallMs` budget is larger than, say, `3x` the smallest contract's
   budget in the same plan. (Factory-fit's amdahl logic could bound this.)
2. Its estimated token spend would dwarf the rest of the plan.
3. Its `writes` set covers a coherent product surface that a senior engineer
   would treat as one ticket — not one file.
4. Its `objective` contains nested verbs ("refactor X and also update Y and
   delete Z") that visibly have separable sub-tasks.

These areheuristic; the real test is the repo-reader re-reads the files and
decides whether a clean boundary exists.

### Proposed mechanism

A single extra step inside `renderPlanPrompt` (plan-demo and plan-full):

**Phase 2 of planning — Split-Pass**

After the first-cut plan is drafted (hits the gate checks), the prompt asks
the planner:

> Before you stop, walk the contracts. For each contract that still looks like
> more than one sitting of work, re-read the repo, split it into smaller
> disjoint contracts with their own checks, and rewrite the plan. If you
> cannot split it — because the work is genuinely one cognitive unit, one
> module, or one transaction — leave it alone. The founder sees the refined
> plan; the split is visible to them as additional contracts.

Rules for the splitter output:

- Output the same plan JSON (same schema).
- Refined contracts refine the *original's* scope (child ⊆ parent); write
  globs may narrow, not widen.
- The refined child contracts may declare their own `role` and `budget`
  independent of the parent they arose from.
- Graph budget (`graphBudget.nodes`, `edges`) must be recomputed, not summed —
  edges may shrink because the refinement creates fewer dependencies than the
  unrefined parent implied.
- Refinement does not happen for contracts of <1000 tokens or <10 minutes.
  It's noise, not value.

### What leaves the plan prompt

The current `renderPlanPrompt` still handles:

- the user request
- scope prose
- design direction (UI plans)
- the schema definition
- "build exactly what the user asked for"
- the single-agent / team-of-N question dispatched by `plan_write`

`renderPlanPrompt` gains a single clause about the split-pass — the same
prompt loop that writes the plan rewrites it in place. Not a new tool, not a
new dispatcher, not a new file format.

### Gate check before dispatch

The current `checkTopology` and the validator still apply to the *refined*
plan. No changes needed. The factory-fit assessment re-evaluates the refined
set before the form is sent, which is the whole point.

## What could go wrong

| Failure | Why it matters | Guard |
|---|---|---|
| Plan explosion | 4 contracts → 14, doubles budget | Cap refinement to 1 pass; only contracts above a threshold get split; max split arity (e.g., one parent → at most 4 children) |
| Fake splits of a genuinely unified unit | "split" produces
 two coupled workers that each pass gates but build nonsense together | Prompt language: if you can't tell where one is finished and the other has begun, it is not two contracts — refuse or leave it |
| Widened scope | Parent replaced by children whose writes leak more than the parent's | Validator `union-scope` still checks; a child's writes are not wider than parent's by construction in the prompt, but the gate catches it anyway |
| Broken doneWhen semantics | Each child needs its own gate; if the parent's doneWhen is global, the children inherit uselessness | Prompt must materialize a `doneWhen` per child that is mechanically checkable — this is the hardest ask and limits the win |
| Plan > review time | Founder reads 12 contracts instead of 4 | Refinement only applies when the founder asked for a full build; demo plans stay as written |

## What is definitely not in scope

- Runtime splitting. A contract in an in-flight run cannot be subdivided.
  That's a dispatch problem; this is a planning problem.
- Sub-agent nesting. Different question, different risks.
- Automatic "reject the split" gates below a size threshold — *probably* fine,
  but needs measurements first. Don't ship a heuristic as a gate in v1.

## What needs proof before this ships

1. **A run that demonstrates top value.** Before any new gate ships, run the
   same plan-full request twice — once with the split-pass and once without —
   and count: passes, re-runs, tokens, minutes. Without the differential, we
   do not know if this helps.
2. **One test corpus that would have failed pre-split.** The complex contract
   we know the founder has in mind — whatever it is — is the only test that
   matters. Split junk stories demonstrate the plumbing works; they don't
   demonstrate the product is better.
3. **A budget signal.** `graphBudget.tokens` must come down when the plan is
   split, not go up. Producing 12 children at twice the parent's cost is
   worse than one complex contract that works.

## Open questions for the founder

1. Do you want a user-visible toggle ("deeper plan" vs "quick plan") or just
   the split-pass baked in?
2. Is there a threshold (minutes, tokens, file-count) that predicts
   "complex" well enough on your real repos?
3. If a parent contract's budget is split across children, do you want to be
   notified why the plan says 12 contracts, or is that fine unchecked?

## Out of scope for this document

The actual implementation, the prompt wording, and the measurement plan are
not here. This is the working note to decide whether split-pass belongs in
Cubicore at all. If not, the design closes with "the prompt already tries" —
but the explicit "walk the contracts and split the big ones" clause in the
plan prompt is the missing half of today's planning flow.

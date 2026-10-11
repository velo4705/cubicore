# Live verification state

## Proven end to end
- `cubicore` tool dispatches and returns: 26.3s wall for a 2-contract fan-out.
- Two associates ran in parallel and each wrote its artifact
  (`module-1.md`, `module-2.md`); both exist with real content.
- The plugin's own event hook is wired: `eventTargets.push(workers)`
  routes `session.idle` to the right observer, and the tool completes.

## OPEN BUG — gates report failure when the command passes

The tool printed:

    fan-out · 0 passed, 2 flagged, 0 deferred
    - doc-a: accepted
    - doc-b: accepted

Those two lines contradict each other, and `dispatch()` guarantees
`accepted` and `failed` are mutually exclusive (`src/dispatch/index.ts:158`).
So the workers were placed in `failed`, while `aggregate` labelled their
artifacts `accepted` — meaning the two disagree about the same run.

Running the gate command by hand passes for both contracts:

    sh -c 'test -f src/module-1.md && grep -q "f0" src/module-1.md'  -> 0

So the failure is in how the gate result is evaluated, not in the work.
Suspect `src/gate/index.ts:183`, reached from `commandRunner` in
`src/index.ts:293`, which returns `{ exitCode, output }`. The
`CommandRunner` field name and the consumer's expectation need checking
against each other; `runGates` takes its args positionally, not as an
object, so a call-site mismatch is plausible.

Not fixed. Do not report this run as passing until the gate verdict and
the aggregate status are made to agree.

## Follow-up — what is ruled out

`CommandRunner` is **not** the mismatch. `src/gate/index.ts:26` declares

    run(command: string): Promise<{ exitCode: number; output: string }>;

and line 109 reads `result.exitCode !== 0`. `commandRunner` in
`src/index.ts:293` returns exactly `{ exitCode, output }`. The
producer and the consumer agree, so drop that hypothesis.

The failure is one of the other two gates, or the artifact they inspect.
`gateSchema` (`src/gate/index.ts:44`) reads `artifact.raw` — not
`artifact.text`. So the `Artifact` shape is load-bearing for the gate
chain, and a hand-built artifact that omits `raw` will make the *schema*
gate fail while the verify command passes. That is a plausible
explanation for "flagged but the command succeeds", and it points at the
artifact produced from the worker session rather than at the command.

Next step: log the actual `GateResult[]` from the live run. Every gate
carries a `detail` string, so one run tells you which gate failed and
why. Do not build another harness artifact by hand — take the one the
gate chain already produced.

## Harness caveat

`scripts/live-tool.ts` drives the real tool, so its verdict is
trustworthy. Any ad-hoc `runGates(...)` call must use the real
`Artifact` shape or it will report failures the product does not have.

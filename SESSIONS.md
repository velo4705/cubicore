# Sessions

Three sessions, each testing one thing the test suite cannot. Each starts in
its own directory with its own git baseline, so a failure is reproducible and
does not contaminate the next one.

Setup, once:

```sh
git init -q . && git add -A && git commit -qm "baseline"
```

The MCP server runs from source (`src/mcp/main.ts`), so no rebuild is needed
after a code change. The plugin is loaded from `dist/index.js` and does need
`bun run build`.

---

## 1. Non-code work

**Directory:** `/tmp/cubicore-research` (already prepared: `sources/`,
`sections/`, `check-sections.mjs`, git initialised with a baseline commit)

**Prompt:**

```
/cubicore:plan

Write one section per document in sources/, into sections/. Each section must
have a "## Sources" heading listing the source path in backticks, must say what
the source claims, and must state what it does not claim. Do not change
sources/.

The check is: node check-sections.mjs .
```

**What it proves.** The contract layer gates work in a domain with no test
suite. There is nothing to compile and nothing to unit test — the check is
about the document: did it cite something that exists, did it drop a source,
does it say what it does not know. The contract names a command; the command
does not have to be a test runner.

**Watch for.** The plan splitting by source (3 contracts, disjoint
`writes`), the check landing in the matrix, and the scope gate noticing if a
worker touches `sources/`.

---

## 2. Refine does not re-run what already passed

**Directory:** a fresh copy of the research fixture, or any project with two
independent contracts.

**Prompt:**

```
/cubicore:plan

Write one section per document in sources/, into sections/. The check is:
node check-sections.mjs .
```

Run it. Then change *one* thing in the request and refine:

```
/cubicore:refine

Only the section for sources/velocity.md needs rewriting. Leave the other two
sections exactly as they are.
```

Then `/cubicore:execute` again.

**What it proves.** The refine → execute skip: a contract whose artifact
already satisfies its `doneWhen` is not re-run. This is the difference between
"refine" and "restart", and it is the main claim the refinement loop rests
on. The second run should touch one contract, not three.

**Watch for.** The run summary naming one re-run contract rather than three,
and the untouched artifacts staying byte-identical.

---

## 3. Deploy

**Directory:** any real project. This one is a conversation before it is a
plan.

**Prompt:**

```
/cubicore:deploy
```

**What it proves.** The path most likely to be wrong, because it was never
run. It has to ask about the tier *before* offering stacks, offer real
trade-offs with one recommendation, then write deploy files with disjoint
scopes and a check that can fail — and then explain the manual steps for
someone who has never deployed that stack.

**Watch for.** The tier question coming first, the recommendation being
named and justified, and the resulting plan validating. The check on a
container definition has to be something that can actually fail, not
`docker build` dressed up as a test.

---

## After the sessions

Record what happened. The numbers matter less than the shape: which paths
worked first time, which needed a second run, and where the product lied to
the founder about something being done.

/**
 * Conventional starting points, for when there is nothing to survey.
 *
 * The research tool surveys a repository. When there is no repository -- a
 * founder who says "make me a multimillion dollar SaaS" in an empty
 * directory -- the survey returns nothing, and the agent responds by going
 * looking with the shell. That is a loop with no exit, and it was the reason a
 * lazy prompt could stall.
 *
 * So the research tool returns something concrete instead: a shortlist of the
 * small things a common developer builds first, each with the stack that is
 * conventional for it. The list is deliberately boring and bounded. It is not
 * a recommendation -- it is the starting set of options the founder can pick
 * from, or the agent can choose from when they are delegating.
 *
 * The agent knows more than this list. It exists so that "what should I build"
 * is answerable without the founder inventing it and without the agent
 * searching the web for an hour.
 */

export interface Slice {
  name: string;
  what: string;
  stack: string;
  /** Why this is a conventional first thing to build. */
  why: string;
  /** The pieces it usually breaks into, which is what a plan would split on. */
  parts: string[];
}

export const CONVENTIONAL_SLICES: readonly Slice[] = [
  {
    name: "url-shortener",
    what: "Shortens a URL, redirects it, and counts the clicks",
    stack: "Node, node:test, SQLite, plain HTTP",
    why: "The smallest thing that is genuinely a service, with a real database and a real redirect",
    parts: ["the short-code generator", "the redirect handler", "the click counter", "the HTTP server"],
  },
  {
    name: "bookmark-manager",
    what: "Saves, tags and searches links",
    stack: "Node, node:test, SQLite",
    why: "One table, one obvious CRUD surface, and search is a real requirement from the first minute",
    parts: ["the store", "the tag index", "the search", "the HTTP server"],
  },
  {
    name: "expense-tracker",
    what: "Records expenses and totals them by category and period",
    stack: "Node, node:test, SQLite",
    why: "The data model is obvious, the totals are easy to check, and the tests are natural",
    parts: ["the entry model", "the category totals", "the period report", "the HTTP server"],
  },
  {
    name: "markdown-notes",
    what: "Stores and searches notes written in markdown",
    stack: "Node, node:test, files on disk",
    why: "No database needed, and the output is readable, so a founder can judge the result by eye",
    parts: ["the note store", "the tag index", "the search", "the HTTP server"],
  },
  {
    name: "webhook-relay",
    what: "Accepts a webhook, retries it, and shows delivery history",
    stack: "Node, node:test, SQLite",
    why: "The retry logic is the interesting part and it is easy to test deterministically",
    parts: ["the delivery queue", "the retry policy", "the history", "the HTTP server"],
  },
  {
    name: "form-collector",
    what: "Serves a form and stores the submissions",
    stack: "Node, node:test, SQLite, plain HTML",
    why: "One endpoint, one table, and the output is something a founder can submit to",
    parts: ["the form renderer", "the submission store", "the results view", "the HTTP server"],
  },
];

/** Render the shortlist for the research output. */
export function renderSlices(slices: readonly Slice[] = CONVENTIONAL_SLICES): string {
  return [
    "## Conventional starting points",
    "",
    "There is no code here yet, so there is nothing to survey. These are the small",
    "things a common developer builds first, with the stack that is conventional for",
    "each. Pick one, or tell the founder what they actually want.",
    "",
    "| Slice | What it is | Stack | Why it's conventional |",
    "|---|---|---|---|",
    ...slices.map((s) => `| **${s.name}** | ${s.what} | ${s.stack} | ${s.why} |`),
    "",
    "Each breaks into parts that make one plan each:",
    "",
    ...slices.map((s) => `- **${s.name}** — ${s.parts.join(", ")}`),
  ].join("\n");
}

/**
 * Failure classification — when a check fails, name what kind of failure it is.
 *
 * The founder's actual question at the end of a run is "what kind of failure
 * is this?" — environment (something missing/unavailable), code (what I wrote
 * doesn't compile/run), format (the correct code is not formatted right), spec
 * (the app is up but doesn't behave like the test demands), budget (something
 * bailed at its limit). Without this, every check failure looks like a `exit 1`
 * and you guess.
 *
 * Buckets are deliberately coarse. The mapper uses recent + common error
 * signatures across JS/TS, Playwright, lints; it is shaded, not certain.
 * What's kept always: when none of the above matches, the answer is "unknown"
 * — never a wrong answer the founder didn't get.
 */

export type CheckFailureKind = "environment" | "code" | "format" | "spec" | "budget" | "unknown";

export function classifyCheckFailure(output: string): CheckFailureKind {
  const hay = output ?? "";
  // Format / style first — lint complaints point at the file, not at the code being broken.
  if (/\[(eslint|prettier|biome|format|lint|ruff)\b|print.?width|prettier\/prettier|eslint --fix|prettier.*print|prettier.*source/i.test(hay)) return "format";
  // Environment: missing tool, missing dependency, missing permission, network, engine mismatch.
  if (
    /command not found|module not found|ENOENT|EACCES|EPERM|cannot find module|cannot find name|Cannot find package|ERR_MODULE_NOT_FOUND|cannot resolve module|node_modules|not installed|missing binary|not authorized|permission denied|offline|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|could not resolve|version|engine/i.test(
      hay,
    )
  ) {
    return "environment";
  }
  // Spec: Playwright's own failures — locator not found, timeout inside expectation, assertion oracles.
  if (
    /locator\.(click|fill|textContent|getBy|count)|expect\(.*\)\.(toBe|toEqual|toHave|toContain|toBeVisible)|playwright|cypress|browser/.test(
      hay,
    )
  ) {
    return "spec";
  }
  // Code: type and syntax errors point at the source files.
  if (
    /error TS\d+|SyntaxError|ReferenceError|TypeError|is not a function|is not defined|is not assignable|Unexpected token|AssertionError|Invariant failed|ERROR in/.test(
      hay,
    )
  ) {
    return "code";
  }
  // Budget / limit — only when the runtime itself bailed (OOM, wall clock, pipe).
  if (/out of memory|OOM|killed|maxBuffer|budget|deadline/i.test(hay)) return "budget";
  return "unknown";
}

export function renderFailureTag(kind: CheckFailureKind): string {
  return kind;
}

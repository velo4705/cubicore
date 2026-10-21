import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Check } from "../contracts/types";

/**
 * The baseline check matrix, derived from the repository.
 *
 * D9 says the matrix is a union computed at validation time: baseline checks
 * come from the project, contract checks may only add. On duplicate commands
 * the baseline entry wins, so a contract cannot lower the bar.
 *
 * The plumbing for that has existed from the start — `effectiveMatrix` takes a
 * baseline, `assertBaselineIntact` refuses a matrix that dropped one — and
 * nothing ever supplied a baseline. So the union was the contract's own
 * checks, and the "baseline wins" rule had nothing to win against.
 *
 * A real run showed the consequence. A plan's project-wide typecheck named no
 * flags and so ran under the project's own tsconfig, which did not enable
 * `noUnusedLocals`. An unused parameter passed every check in the matrix. The
 * five per-contract typechecks in the same plan *did* name the strict flags;
 * the one that checked the whole project did not, and it was the one that
 * mattered.
 *
 * So the baseline is authored here, once, with the strict flags named. A plan
 * cannot forget them because a plan does not write them.
 */

/** The strictness a Node/TypeScript project is checked at when we can tell. */
const TS_STRICT_FLAGS = [
  "--strict",
  "--noUncheckedIndexedAccess",
  "--exactOptionalPropertyTypes",
  "--erasableSyntaxOnly",
  "--verbatimModuleSyntax",
  "--allowImportingTsExtensions",
  "--noUnusedLocals",
  "--noUnusedParameters",
  "--module nodenext",
  "--moduleResolution nodenext",
  "--target es2023",
];

export interface BaselineOptions {
  /** Skip the checks whose tools are not installed. */
  probe?: (command: string) => boolean;
}

function hasScript(pkg: Record<string, unknown>, name: string): string | undefined {
  const scripts = pkg.scripts as Record<string, string> | undefined;
  const value = scripts?.[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Derive the baseline from what the repository actually has.
 *
 * Nothing is invented: a project without a test script gets no test baseline.
 * The one thing this adds beyond the project's own configuration is the
 * strictness, because a project's own compiler settings are exactly what let
 * a defect through.
 */
export function deriveBaseline(root: string, options: BaselineOptions = {}): Check[] {
  const checks: Check[] = [];

  const pkg = readJson(join(root, "package.json"));
  if (!pkg) return checks;

  const hasTsconfig = existsSync(join(root, "tsconfig.json"));
  const isTypeScript = hasTsconfig || existsSync(join(root, "src")) ||
    (pkg.devDependencies as Record<string, string> | undefined)?.typescript !== undefined;

  // The project's own typecheck, checked strictly. The flags are named rather
  // than inherited, because inheriting them is how an unused parameter passed
  // every check in the matrix.
  if (isTypeScript) {
    checks.push({
      id: "baseline-typecheck-strict",
      kind: "baseline",
      command: `npm exec --no -- tsc --noEmit --ignoreConfig ${TS_STRICT_FLAGS.join(" ")}`,
      expectation:
        "Every TypeScript file in the project compiles with zero errors under the strict " +
        "flag set: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, " +
        "erasableSyntaxOnly, verbatimModuleSyntax, noUnusedLocals and noUnusedParameters. " +
        "The flags are named rather than inherited from tsconfig.json, so a lax project " +
        "configuration cannot hide an unused import, an unused parameter or an unchecked index.",
      gating: "blocking",
      convergent: true,
    });
  }

  const test = hasScript(pkg, "test");
  if (test) {
    checks.push({
      id: "baseline-test-suite",
      kind: "baseline",
      command: "npm test",
      expectation:
        "The project's own test suite passes. Written once, by the project, rather than " +
        "per task — it is the bar every contract is measured against.",
      gating: "blocking",
      convergent: true,
    });
  }

  const lint = hasScript(pkg, "lint");
  if (lint) {
    checks.push({
      id: "baseline-lint",
      kind: "baseline",
      command: "npm run lint",
      expectation: "The project's own linter reports no problems.",
      gating: "blocking",
      convergent: true,
    });
  }

  const build = hasScript(pkg, "build");
  if (build) {
    checks.push({
      id: "baseline-build",
      kind: "baseline",
      command: "npm run build",
      expectation: "The project builds.",
      gating: "blocking",
      convergent: true,
    });
  }

  return checks;
}

/** The strict flags, exported so a plan can name them consistently. */
export const STRICT_TS_FLAGS = TS_STRICT_FLAGS;

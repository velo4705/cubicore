/**
 * The repository the benchmark measures against.
 *
 * It must match the corpus plan exactly. The plan names twelve modules to
 * document; running it against a different tree would have every associate
 * read files that do not exist, and the arm would be measuring a plan that
 * could never have succeeded.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import plan from "../src/bench/plans/real-project.json";

export const FIXTURE_DIR = "/tmp/opencode/benchrepo";

const NAMES = (plan.contracts as { id: string }[]).map((c) => c.id.replace(/^doc-/, ""));

export function writeFixture(root = FIXTURE_DIR): string {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });

  for (const [i, name] of NAMES.entries()) {
    // A body with enough shape that documenting it costs something real, and
    // a named export the check can grep for.
    writeFileSync(
      join(root, "src", `${name}.ts`),
      `/**
 * ${name} — module ${i + 1} of the benchmark fixture.
 *
 * Deliberately non-trivial: a two-line module makes the documentation work
 * too cheap to measure, and the difference between arms disappears into noise
 * the way a ~36K session prefix does.
 */

export interface ${pascal(name)}Options {
  strict?: boolean;
  limit?: number;
}

export interface ${pascal(name)}Result {
  ok: boolean;
  value: number;
  notes: string[];
}

/** Bare words to be tokenised. */
export const ${camel(name)}Words: string[] = [
${Array.from({ length: 12 }, (_, w) => `  "token-${w + 1}-${name}",`).join("\n")}
];

/**
 * Primary operation. Handles empty input, an over-limit input, and strict mode.
 */
export function ${camel(name)}(input: string, options: ${pascal(name)}Options = {}): ${pascal(name)}Result {
  const limit = options.limit ?? ${10 + i};
  const notes: string[] = [];
  let value = 0;

  if (input.length === 0) {
    return { ok: false, value: 0, notes: ["empty input"] };
  }

  const trimmed = input.trim();
  if (trimmed.length > limit) {
    notes.push(\`input exceeds limit \${limit}, truncated\`);
  }

  for (const [index, char] of [...trimmed.slice(0, limit)].entries()) {
    value += char.charCodeAt(0) + index;
  }

  if (options.strict && notes.length > 0) {
    return { ok: false, value, notes };
  }

  return { ok: true, value, notes };
}
`,
    );
  }

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "benchrepo", private: true, type: "module" }, null, 2),
  );
  writeFileSync(
    join(root, "check.sh"),
    "#!/bin/sh\nset -e\nbunx --bun tsc --noEmit --ignoreConfig src/*.ts\n",
  );

  return root;
}

export function cleanFixture(root = FIXTURE_DIR): void {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

const pascal = (s: string) => s.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());
const camel = (s: string) => pascal(s).replace(/^./, (c) => c.toLowerCase());

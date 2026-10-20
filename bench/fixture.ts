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

const pascal = (s: string) => s.replace(/(^|_)(\w)/g, (_: string, __: string, c: string) => c.toUpperCase());
const camel = (s: string) => pascal(s).replace(/^./, (c) => c.toLowerCase());

/**
 * One module of the fixture.
 *
 * Deliberately substantial. A two-line module makes the documentation work
 * too cheap to measure, and the difference between arms disappears into noise
 * the way a ~36K session prefix does. This is roughly what a real module
 * costs to read carefully and describe accurately.
 */
function moduleSource(name: string, index: number): string {
  const P = pascal(name);
  const c = camel(name);
  const words = Array.from({ length: 24 }, (_, w) => `  "token-${w + 1}-${name}",`).join("\n");
  const reserved = Array.from({ length: 6 }, (_, w) => `  "reserved-${w + 1}-${name}",`).join("\n");

  return `/**
 * ${name} — module ${index + 1} of the benchmark fixture.
 *
 * Deliberately substantial. A two-line module makes the documentation work too
 * cheap to measure, and the difference between arms disappears into noise the
 * way a ~36K session prefix does.
 */

export interface ${P}Options {
  /** Reject input rather than coercing it. */
  strict?: boolean;
  /** Maximum items to process. */
  limit?: number;
  /** How to treat duplicates. */
  duplicates?: "keep" | "first" | "last";
}

export interface ${P}Result {
  ok: boolean;
  value: number;
  items: string[];
  notes: string[];
}

/** The vocabulary this module understands. */
export const ${c}Words: string[] = [
${words}
];

/** Words that carry a special meaning and are handled separately. */
export const ${c}Reserved: Set<string> = new Set([
${reserved}
]);

/**
 * Normalise a single item: trim it, fold it to lower case, and drop anything
 * that is not alphanumeric.
 *
 * @param input - The raw item.
 * @param options - Strictness, limit and duplicate handling.
 * @returns The normalised value plus any notes worth surfacing.
 */
export function ${c}One(
  input: string,
  options: ${P}Options = {},
): { value: string; notes: string[] } {
  const notes: string[] = [];
  if (input.length === 0) {
    return { value: "", notes: ["empty input"] };
  }

  const trimmed = input.trim();
  if (trimmed !== input) {
    notes.push("input was trimmed");
  }

  const lower = trimmed.toLowerCase();
  const cleaned = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  if (cleaned.length === 0) {
    notes.push("nothing survived normalisation");
  }
  if (options.strict && notes.length > 0) {
    return { value: cleaned, notes };
  }
  return { value: cleaned, notes };
}

/**
 * Process a batch of items, applying the options consistently.
 *
 * @param inputs - The raw items.
 * @param options - Strictness, limit and duplicate handling.
 * @returns A result carrying the items, a checksum, and any notes.
 */
export function ${c}(
  inputs: readonly string[],
  options: ${P}Options = {},
): ${P}Result {
  const limit = options.limit ?? 32;
  const notes: string[] = [];
  const items: string[] = [];
  const seen = new Set<string>();
  let value = 0;

  if (inputs.length === 0) {
    return { ok: false, value: 0, items: [], notes: ["no input"] };
  }
  if (inputs.length > limit) {
    notes.push(\`\${inputs.length} inputs exceeds limit \${limit}\`);
  }

  for (const [index, raw] of inputs.slice(0, limit).entries()) {
    const one = ${c}One(raw, options);
    notes.push(...one.notes.map((n) => \`[\${index}] \${n}\`));

    if (options.duplicates === "first" && seen.has(one.value)) continue;
    if (options.duplicates === "last" && seen.has(one.value)) {
      items[items.indexOf(one.value)] = one.value;
      continue;
    }

    seen.add(one.value);
    items.push(one.value);
    for (const [i, char] of [...one.value].entries()) {
      value += char.charCodeAt(0) * (i + 1);
    }
  }

  if (${c}Reserved.size > 0 && items.length === 0) {
    notes.push("every item was reserved");
  }

  return { ok: notes.length === 0, value, items, notes };
}
`;
}

export function writeFixture(root = FIXTURE_DIR): string {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });

  NAMES.forEach((name, index) => {
    writeFileSync(join(root, "src", `${name}.ts`), moduleSource(name, index));
  });

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

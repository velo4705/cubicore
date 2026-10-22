#!/usr/bin/env node
/**
 * Checks a written section, without a single test framework.
 *
 * The point of this fixture is that the work is not code. There is nothing to
 * compile and nothing to unit test, so the checks have to be about the
 * document itself -- and that is exactly the question: can Cubicore split and
 * verify work in a domain that has no test suite?
 *
 * A section is a markdown file under sections/. The rules:
 *
 *  1. Every source it cites is listed under "## Sources", as a path.
 *  2. Every path under "## Sources" exists in sources/.
 *  3. Every source in sources/ is cited by at least one section, so no source
 *     is quietly dropped.
 *  4. It says what it found and what it did not, so a section that asserts
 *     nothing is not a section.
 *
 * Exits non-zero with a reason, which is what makes it a check Cubicore can
 * gate on.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename, relative } from "node:path";

const root = process.argv[2] ?? process.cwd();
const sectionsDir = join(root, "sections");
const sourcesDir = join(root, "sources");

const problems = [];

if (!existsSync(sectionsDir)) {
  console.error(`no sections/ directory in ${root}`);
  process.exit(1);
}

const sections = readdirSync(sectionsDir).filter((f) => f.endsWith(".md"));
if (sections.length === 0) {
  console.error("sections/ is empty — nothing was written");
  process.exit(1);
}

const sources = existsSync(sourcesDir)
  ? readdirSync(sourcesDir).filter((f) => f.endsWith(".md"))
  : [];
const cited = new Set();

for (const file of sections) {
  const text = readFileSync(join(sectionsDir, file), "utf8");

  if (!/^##\s+Sources\s*$/m.test(text)) {
    problems.push(`${file}: no "## Sources" section`);
  }

  const block = /##\s+Sources\s*\n([\s\S]*?)(?=\n##\s|\s*$)/.exec(text);
  const listed = block
    ? [...block[1].matchAll(/`([^`]+)`/g)].map((m) => m[1])
    : [];

  if (listed.length === 0) {
    problems.push(`${file}: cites nothing`);
  }

  for (const path of listed) {
    if (!existsSync(join(root, path))) {
      problems.push(`${file}: cites "${path}", which does not exist`);
      continue;
    }
    cited.add(basename(path));
  }

  // A section that only lists sources has not synthesised anything.
  const prose = text
    .split(/^##\s+/m)
    .slice(0, 2)
    .join("\n")
    .replace(/^#.*$/m, "")
    .trim();
  if (prose.length < 200) {
    problems.push(`${file}: says almost nothing (${prose.length} characters of prose)`);
  }

  if (!/\b(not|unknown|unclear|no evidence|could not|cannot confirm|gap)\b/i.test(text)) {
    problems.push(`${file}: states no limitation — a section with no uncertainty is not a finding`);
  }
}

for (const source of sources) {
  if (!cited.has(source)) {
    problems.push(`sources/${source} is not cited by any section`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}

console.log(
  `ok: ${sections.length} section(s), ${cited.size} source(s) cited, all present and all used`,
);

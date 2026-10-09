import type { TaskSpec } from "./types";

/**
 * The benchmark corpus.
 *
 * Every task here is **genuinely decomposable** — disjoint files, no shared
 * interface — because that is the premise under test. A corpus containing
 * interface changes or cross-cutting refactors would measure the wrong thing:
 * Cubicore is designed to *refuse* those, so they belong in a refusal corpus
 * rather than a speed one.
 *
 * Tasks are also sized so real work dominates the ~36K-token session prefix. A
 * trivial task measures the bootstrap floor for all three arms and the
 * orchestration difference disappears into noise.
 *
 * `expectedWorkers` is what the naive-fanout control is sized by. It has to
 * match what an orchestrator would plausibly choose, or the comparison is not
 * like-for-like.
 */
export const CORPUS: TaskSpec[] = [
  {
    id: "t1-explain",
    // Separable by file. Read-only, so no collision is even possible.
    prompt:
      "Read src/module-{N}.ts and reply with a two-sentence summary of what it does. " +
      "Reply with the summary and nothing else. Replace {N} with your file's number.",
    expectedWorkers: 4,
  },
  {
    id: "t2-docstring",
    // Separable by file, and each worker writes only its own.
    prompt:
      "Add a one-line JSDoc comment above the exported function in src/module-{N}.ts " +
      "describing what it returns. Do not change anything else. " +
      "Replace {N} with your file's number.",
    expectedWorkers: 4,
  },
];

/** Expands `{N}` into a 1-based worker index. */
export function promptFor(spec: TaskSpec, index: number): string {
  return spec.prompt.replace(/\{N\}/g, String(index + 1));
}
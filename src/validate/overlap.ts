/**
 * Structural glob overlap.
 *
 * Complete glob intersection is undecidable in general, so this is a
 * conservative over-approximation: it answers "might these two patterns ever
 * match the same path?" rather than "do they?".
 *
 * The direction of the error is deliberate. Over-reporting overlap rejects a
 * workable plan and costs one re-plan. Under-reporting lets two workers write
 * the same file and costs the user a merge conflict.
 */

const WILDCARDS = new Set(["*", "?", "[", "{", "!", "(", "+", "@"]);

function literalPrefix(pattern: string): string {
  let out = "";
  for (const char of pattern) {
    if (WILDCARDS.has(char)) break;
    out += char;
  }
  return out;
}

export function patternsOverlap(a: string, b: string): boolean {
  const prefixA = literalPrefix(a);
  const prefixB = literalPrefix(b);

  if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)) return true;

  return false;
}

export function overlaps(a: string[], b: string[]): boolean {
  for (const left of a) {
    for (const right of b) {
      if (patternsOverlap(left, right)) return true;
    }
  }
  return false;
}

export function overlapPairs(a: string[], b: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (const left of a) {
    for (const right of b) {
      if (patternsOverlap(left, right)) pairs.push([left, right]);
    }
  }
  return pairs;
}
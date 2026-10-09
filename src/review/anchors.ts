/**
 * Resolving a check command to the file value that defines it.
 *
 * The reviewer needs to know one thing: did the definition of a check change
 * between the failed attempt and the retry? `npm run lint` is a string, but it
 * points at `package.json` → `scripts.lint`, and a worker under pressure can
 * edit that instead of the code.
 *
 * Only `npm run X` / `bun run X` style commands resolve. Bare commands like
 * `tsc` or `vitest` have no inspectable anchor and are skipped rather than
 * guessed at — an unresolvable command is not evidence of tampering.
 */

export interface CheckAnchor {
  /** The check command this came from. */
  command: string;
  /** File holding the definition, e.g. "package.json". */
  file: string;
  /** Dotted path within that file, e.g. "scripts.lint". */
  key: string;
  value: string;
}

const SCRIPT_RUNNERS = /^(?:npm|pnpm|yarn|bun)\s+(?:run|run-script)\s+(\S+)/;

export type ReadFile = (path: string) => string | null;

/** Returns the anchor a command points at, or null when it has none. */
export function anchorFor(command: string, readFile: ReadFile): CheckAnchor | null {
  const match = SCRIPT_RUNNERS.exec(command.trim());
  if (!match) return null;

  const script = match[1];
  const file = "package.json";
  const raw = readFile(file);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // An unparseable manifest is not evidence about a specific check.
    return null;
  }

  const value = readPath(parsed, ["scripts", script]);
  if (typeof value !== "string") return null;

  return { command, file, key: `scripts.${script}`, value };
}

/** Maps each anchorable command to its current value. */
export function snapshotAnchors(
  commands: readonly string[],
  readFile: ReadFile,
): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const command of commands) {
    const anchor = anchorFor(command, readFile);
    if (anchor) anchors.set(command, anchor.value);
  }
  return anchors;
}

export interface MovedAnchor {
  command: string;
  file: string;
  key: string;
  before: string;
  after: string;
}

/**
 * Checks whose definition changed.
 *
 * A command present before and gone after counts as moved: deleting the
 * `lint` script makes `npm run lint` fail, but deleting a test file that a
 * passing command sweeps up makes it pass silently — which is the case that
 * matters.
 */
export function movedAnchors(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): MovedAnchor[] {
  const moved: MovedAnchor[] = [];

  for (const [command, previous] of before) {
    const current = after.get(command);
    if (current === previous) continue;

    moved.push({
      command,
      file: "package.json",
      key: command,
      before: previous,
      after: current ?? "(removed)",
    });
  }

  return moved;
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
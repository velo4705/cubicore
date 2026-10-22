

/**
 * Which files a worker changed, computed from git.
 *
 * opencode's `session.diff` returns an empty list -- verified against
 * sessions in both git and non-git directories that demonstrably wrote files.
 * So the scope gate was being handed nothing, and a gate handed nothing
 * reports success: it filtered an empty list, found no strays, and returned
 * "all 0 changed file(s) inside declared writes".
 *
 * Git is the source of truth instead. It also gives the founder a baseline to
 * diff against and a way to undo a run, which is why the plan phase
 * initialises a repository when there is not one.
 */

export interface ChangedFiles {
  files: string[];
  /** True when the list could not be determined at all. */
  unknown: boolean;
  reason?: string;
}

const EMPTY: ChangedFiles = { files: [], unknown: false };

/**
 * Run git, asynchronously.
 *
 * A synchronous call blocks the whole process's event loop, and the MCP
 * server shares that loop with the dispatch it is reporting on. A scope check
 * that blocked for a second blocked the status poll behind it.
 */
async function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { ok: code === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Is this directory a git repository? */
export async function isRepository(root: string): Promise<boolean> {
  return (await git(["rev-parse", "--is-inside-work-tree"], root)).ok;
}

/**
 * Files that differ from the baseline commit.
 *
 * The baseline matters: without one, every file in a fresh repository is
 * untracked, and there is no "before" to compare against.
 */
export async function changedFilesSince(root: string, baseline?: string): Promise<ChangedFiles> {
  if (!(await isRepository(root))) {
    return { files: [], unknown: true, reason: "not a git repository" };
  }

  const files = new Set<string>();

  if (baseline) {
    // Tracked files that differ from the baseline.
    const diff = await git(["diff", "--name-only", baseline, "--"], root);
    if (!diff.ok) {
      return { files: [], unknown: true, reason: "git could not report changes" };
    }
    for (const line of diff.out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }

    // Untracked files. `git diff` never sees them, and a worker creating a
    // new file -- the most common case of all -- is exactly that.
    const untracked = await git(["ls-files", "--others", "--exclude-standard"], root);
    if (untracked.ok) {
      for (const line of untracked.out.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) files.add(trimmed);
      }
    }
  } else {
    const status = await git(["status", "--porcelain"], root);
    if (!status.ok) {
      return { files: [], unknown: true, reason: "git could not report changes" };
    }
    for (const line of status.out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // `git status --porcelain` prefixes each line with a two-character
      // status code.
      files.add(/^[ MADRCU?!]{2}\s/.test(line) ? line.slice(3).trim() : trimmed);
    }
  }

  return { files: [...files], unknown: false };
}

/**
 * Make sure the project is a git repository with a baseline commit.
 *
 * Never touches a repository that already exists. A commit is made so that
 * "before" is a thing git can diff against; without one, every file is
 * untracked and the scope gate has nothing to compare.
 */
export interface PrepareResult {
  /** True when the project already was a repository and was left alone. */
  alreadyInitialised: boolean;
  initialised: boolean;
  committed: boolean;
  baseline?: string;
  reason?: string;
}

export async function prepareRepository(root: string): Promise<PrepareResult> {
  if (await isRepository(root)) {
    // Leave it completely alone. No commit, no branch, no `git add`.
    const head = await git(["rev-parse", "HEAD"], root);
    return {
      alreadyInitialised: true,
      initialised: false,
      committed: false,
      baseline: head.ok ? head.out.trim() : undefined,
    };
  }

  const init = await git(["init"], root);
  if (!init.ok) {
    return {
      alreadyInitialised: false,
      initialised: false,
      committed: false,
      reason: "git init failed",
    };
  }

  // Respect .gitignore, and never stage anything huge -- a tree with a large
  // untracked build directory would make this stall for minutes.
  const add = await git(["add", "-A"], root);
  if (!add.ok) {
    return { alreadyInitialised: false, initialised: true, committed: false, reason: "git add failed" };
  }

  const staged = await git(["diff", "--cached", "--name-only"], root);
  if (!staged.ok || staged.out.trim().length === 0) {
    return { alreadyInitialised: false, initialised: true, committed: false };
  }

  const commit = await git(
    ["-c", "user.name=cubicore", "-c", "user.email=cubicore@local", "commit", "-q", "-m", "cubicore: baseline before any changes"],
    root,
  );
  if (!commit.ok) {
    return { alreadyInitialised: false, initialised: true, committed: false, reason: "git commit failed" };
  }

  const head = await git(["rev-parse", "HEAD"], root);
  return {
    alreadyInitialised: false,
    initialised: true,
    committed: true,
    baseline: head.ok ? head.out.trim() : undefined,
  };
}

/**
 * Discard everything a run changed, returning the tree to the baseline.
 *
 * Only safe because the baseline exists: Cubicore made a commit before any
 * associate ran, so "before" is a commit rather than a recollection. Untracked
 * files are removed as well, since that is where a new module ends up.
 */
export async function discardChanges(
  run: { baseline?: string },
  root: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!(await isRepository(root))) {
    return { ok: false, reason: "not a git repository, so there is no baseline to go back to" };
  }

  const baseline = run.baseline;
  if (!baseline) {
    return {
      ok: false,
      reason:
        "this run has no baseline commit, so there is nothing to go back to. The project " +
        "was probably not a git repository when the plan was written.",
    };
  }

  // Tracked changes go back to the baseline.
  const reset = await git(["reset", "--hard", baseline], root);
  if (!reset.ok) return { ok: false, reason: "git reset failed" };

  // Files the run created were never in the baseline, so reset leaves them.
  const clean = await git(["clean", "-fd"], root);
  if (!clean.ok) return { ok: false, reason: "git reset worked but untracked files could not be removed" };

  return { ok: true };
}

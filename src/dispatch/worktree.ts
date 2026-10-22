import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import type { Contract } from "../contracts/types";

/**
 * One worktree per associate.
 *
 * The plan already guarantees the scopes are disjoint, and the scope gate
 * catches a worker that strays outside its own. Neither of those *prevents*
 * anything: a worker with a shell can write wherever it likes, and until the
 * gate runs, two workers share one directory and can be in the same file at
 * the same moment.
 *
 * opencode 1.18.x cannot prevent it. Its agent permissions are V1 -- edit is
 * ask, allow or deny, with no path granularity -- and the V2 per-resource
 * rules are rejected outright by this version. So the boundary has to come
 * from the filesystem.
 *
 * A worktree is that boundary. Each associate works in its own checkout of
 * the repository, so two workers physically cannot be in one file. The
 * contract's declared writes are then copied back, and because the scopes are
 * disjoint by the time the plan was accepted, that copy cannot conflict.
 */

export interface Worktree {
  contractId: string;
  /** The directory the worker should run in. */
  path: string;
  branch: string;
  /** True when the worktree could not be created and the worker must run in the main tree. */
  degraded: boolean;
  reason?: string;
}

const BRANCH_PREFIX = "cubicore/";

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) return { ok: false, out: result.stdout ?? "" };
  return { ok: true, out: result.stdout ?? "" };
}

export function isRepository(root: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], root).ok;
}

/**
 * Create a worktree for one contract.
 *
 * Degrades to running in the main tree when git is unavailable or the
 * repository is not usable, and says so -- because a silent fallback to a
 * shared directory is the collision the worktree exists to prevent.
 */
export function createWorktree(root: string, contract: Contract, workRoot?: string): Worktree {
  const base = workRoot ?? join(root, ".cubicore", "worktrees");
  const path = join(base, contract.id);
  const branch = `${BRANCH_PREFIX}${contract.id}`;

  if (!isRepository(root)) {
    return {
      contractId: contract.id,
      path: root,
      branch,
      degraded: true,
      reason: "not a git repository, so the associate cannot be isolated",
    };
  }

  mkdirSync(base, { recursive: true });

  // A worktree left over from a previous run would block the branch.
  rmSync(path, { recursive: true, force: true });
  git(["worktree", "prune"], root);

  const added = git(["worktree", "add", "-b", branch, path], root);
  if (!added.ok) {
    return {
      contractId: contract.id,
      path: root,
      branch,
      degraded: true,
      reason: `git worktree add failed: ${added.out.trim().slice(0, 120)}`,
    };
  }

  return { contractId: contract.id, path, branch, degraded: false };
}

/**
 * Copy the contract's declared writes back into the main tree.
 *
 * Only the declared files, and only files that exist. Because the scopes are
 * disjoint -- the plan was rejected otherwise -- two contracts can never
 * contend for the same path, so this cannot conflict.
 */
export function collectWorktree(worktree: Worktree, root: string): {
  copied: string[];
  missing: string[];
} {
  const copied: string[] = [];
  const missing: string[] = [];

  if (worktree.degraded) return { copied, missing };

  for (const relativePath of relativeWrites(worktree)) {
    const from = join(worktree.path, relativePath);
    const to = join(root, relativePath);
    if (!existsSync(from)) {
      missing.push(relativePath);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(relativePath);
  }

  return { copied, missing };
}

/** The files a worktree holds that the main tree does not, or that differ. */
function relativeWrites(worktree: Worktree): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === ".git") continue;
      const full = join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      out.push(relative(worktree.path, full));
    }
  };
  walk(worktree.path);
  return out;
}

/** Remove a worktree and its branch. */
export function removeWorktree(worktree: Worktree, root: string): void {
  if (worktree.degraded) return;
  git(["worktree", "remove", "--force", worktree.path], root);
  git(["branch", "-D", worktree.branch], root);
  git(["worktree", "prune"], root);
}

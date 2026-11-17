/**
 * Evidence seal — the design-time guarantee that the instrument used to
 * judge the work did not change after the plan was accepted.
 *
 * The founder's pain point: a contract can reach "done" after passing a
 * check that was rewritten mid-run to accept an easier path. Which files
 * feed which checks is not always direct, but blocking checks already
 * declare their commands, and most real check commands name the files they
 * judge. This module seals those files at plan acceptance and re-checks
 * them at verify time; it seals the commands themselves the same way.
 *
 * This is not a lie-detector. A determined breach can rewrite a check file
 * and run the whole plan flow through Cubicore again. What it stops is the
 * quiet case — the orchestrator or a worker honing the instrument so it
 * passes, without anyone deciding that is allowed. The seal can always be
 * broken loudly (rewrite the plan, accept the seal fresh); it cannot be
 * broken silently.
 *
 * It also does not tighten the evidence cone to nothing: files that only
 * appear during the run (created by a contract) are recorded once at first
 * verify, then enrolled; appearance is noticed but never blocking.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, Plan } from "../contracts/types";

export const EVIDENCE_FILE = ".cubicore-evidence.json";
const VERSION = 1;

export interface FileRecord {
  /** SHA-256 of the file's bytes (only for seal-complete files). */
  sha256?: string;
  /** SHA-256 of just the "scripts" block, for package.json — a dependencies edit is not a defect. */
  scriptsSha256?: string;
  /** True when the path did not exist at seal time — the file may be created during the run. */
  absent?: true;
  /** The commands that referenced this file, for the report. */
  referencedBy?: string[];
}

export interface EvidenceManifest {
  version: number;
  recordedAt: string;
  /** Relative path → record. */
  files: Record<string, FileRecord>;
  /** contractId → sorted blocking check commands. */
  commands: Record<string, string[]>;
}

/** Extensions the evidence cone cares about. Implemented code is NOT evidence. */
const EVIDENCE_EXTENSIONS = new Set([
  ".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx",
  ".json", ".yaml", ".yml", ".toml", ".html", ".css",
  ".sh", ".py", ".rb",
]);

const NOISE = new Set([
  "npx", "node", "npm", "npx", "bun", "bunx", "pnpm", "yarn", "jest", "vitest",
  "pytest", "playwright", "tsc", "mocha", "lint", "fmt", "eslint", "prettier",
]);

/** Extract plausible evidence file paths from a check command. */
export function extractEvidencePaths(command: string): string[] {
  const tokens = command.split(/\s+/);
  const out: string[] = [];
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["'][,;:.]?$/g, "").replace(/^\.\//, "");
    if (!token || NOISE.has(token.toLowerCase())) continue;
    // Bare flags and flags' values that aren't paths (e.g. --reporter)
    if (token.startsWith("-") && !token.includes(".")) continue;
    const isPath =
      /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.(json|yaml|yml|toml|ts|js|mjs|cjs|tsx|jsx|html|css|sh|py|rb)$/.test(token)
      || /^package(-lock)?\.json$/.test(token)
      || /^tsconfig/.test(token)
      || /(vitest|jest|playwright|eslint|prettier).*(config|rc)/.test(token);
    if (!isPath) continue;
    // A path like tests/foo.spec.ts that does not exist *yet* may be created
    // by a contract during the run — seal it as absent so it has an initial
    // baseline at creation.
    out.push(token);
  }
  // `npm run build` does not name package.json, but the script it runs lives
  // there. Same for pnpm/bun/yarn. Any JS/node family command almost certainly
  // reads it, so it is evidence.
  if (/\b(npm|pnpm|bun|yarn)\s+run\b/.test(command) || /\b(npm|npx|node|pnpm|bun|yarn|bunx)\b/.test(command)) {
    out.push("package.json");
  }
  return [...new Set(out)];
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The `scripts` block of a package.json, hashed — anything else (deps, name, version) is not evidence. */
function scriptsSha256(path: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const scripts = pkg && typeof pkg === "object" ? (pkg as Record<string, unknown>).scripts : undefined;
    const canonical = JSON.stringify(scripts ?? null);
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    return undefined;
  }
}

function blockingCommands(contract: Plan["contracts"][number]): string[] {
  return contract.checks
    .filter((c: Check) => c.gating === "blocking" && c.kind !== "judgment")
    .map((c) => c.command)
    .sort();
}

export interface EvidenceCheckResult {
  /** Human-readable evidence problem, or undefined if clean. */
  problems: string[];
  /** Files that appeared during the run and were enrolled (not blocking). */
  appeared: string[];
}

/**
 * Build the seal from a plan at acceptance time.
 * Written to <directory>/.cubicore-evidence.json.
 */
export function buildEvidence(directory: string, plan: Plan): EvidenceManifest {
  const files: Record<string, FileRecord> = {};
  const commands: Record<string, string[]> = {};

  for (const contract of plan.contracts) {
    const cmds = blockingCommands(contract);
    if (cmds.length > 0) commands[contract.id] = cmds;

    for (const command of cmds) {
      for (const rel of extractEvidencePaths(command)) {
        const abs = join(directory, rel);
        const record = files[rel] ?? {};
        record.referencedBy = [...new Set([...(record.referencedBy ?? []), ...cmds])];
        try {
          if (existsSync(abs) && statSync(abs).isFile()) {
            if (rel === "package.json") {
              const scripts = scriptsSha256(abs);
              if (scripts !== undefined) record.scriptsSha256 = scripts;
            } else {
              record.sha256 = sha256File(abs);
            }
            delete record.absent;
          } else {
            record.absent = true;
          }
        } catch {
          record.absent = true;
        }
        files[rel] = record;
      }
    }
  }

  const manifest: EvidenceManifest = {
    version: VERSION,
    recordedAt: new Date().toISOString(),
    files,
    commands,
  };
  try {
    writeFileSync(join(directory, EVIDENCE_FILE), JSON.stringify(manifest, null, 2));
  } catch (error) {
    process.stderr.write(`[cubicore] evidence seal could not be written: ${String(error).slice(0, 200)}\n`);
  }
  return manifest;
}

export interface ReadEvidence {
  ok: boolean;
  manifest?: EvidenceManifest;
  reason?: string;
}

/** Read the seal; absent file = "no seal, nothing to enforce" — preexisting plans, not a failure. */
export function readEvidence(directory: string): ReadEvidence {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, EVIDENCE_FILE), "utf8")) as EvidenceManifest;
    if (!parsed || parsed.version !== VERSION) {
      return { ok: false, reason: "evidence seal version mismatch — re-accept the plan" };
    }
    return { ok: true, manifest: parsed };
  } catch {
    return { ok: false, reason: "no evidence seal on disk — nothing enforced (plan may predate the seal)" };
  }
}

/**
 * Check the current tree against the seal.
 * `plan` is the CURRENT plan (post-run), used for command comparison.
 * Returns problems (blocking) and appearances (informational).
 */
export function checkEvidence(directory: string, plan: Plan): EvidenceCheckResult {
  const problems: string[] = [];
  const appeared: string[] = [];
  const seal = readEvidence(directory);
  if (!seal.ok || !seal.manifest) {
    return { problems, appeared }; // no seal — cannot enforce; surface nothing either way
  }
  const { manifest } = seal;

  for (const [rel, record] of Object.entries(manifest.files)) {
    const abs = join(directory, rel);
    if (record.absent) {
      if (existsSync(abs) && statSync(abs).isFile()) {
        // Created by a contract mid-run. Enrol it now — it joins the seal
        // with the hash it has at first sight, so later rewrites of it are
        // caught as evidence modifications.
        appeared.push(rel);
        // Enrol immediately so the NEXT verify has a baseline.
        try {
          record.sha256 = sha256File(abs);
          delete record.absent;
        } catch { /* unreadable — leave as absent */ }
      }
      // Still absent: fine, the contract may create it.
      continue;
    }
    if (!existsSync(abs)) {
      problems.push(`evidence file missing: ${rel} (was sealed by ${record.referencedBy?.[0] ?? "a check command"})`);
      continue;
    }
    if (rel === "package.json" && record.scriptsSha256) {
      const current = scriptsSha256(abs);
      if (current === undefined || current !== record.scriptsSha256) {
        problems.push(
          `evidence modified: package.json#scripts (referenced by ${record.referencedBy?.[0] ?? "a check command"}) — ` +
          `a verify-scoped script changed mid-flight`,
        );
      }
      continue;
    }
    if (!record.sha256) continue;
    let current: string;
    try {
      current = sha256File(abs);
    } catch {
      problems.push(`evidence file unreadable: ${rel}`);
      continue;
    }
    if (current !== record.sha256) {
      problems.push(
        `evidence modified: ${rel} (referenced by ${record.referencedBy?.[0] ?? "a check command"}) — ` +
        `the instrument this run judged against changed mid-flight`,
      );
    }
  }

  persistEnrollment(directory, manifest, appeared);

  for (const contract of plan.contracts) {
    const sealed = manifest.commands[contract.id];
    if (!sealed) continue;
    const current = blockingCommands(contract);
    if (current.join("\u001f") !== sealed.join("\u001f")) {
      problems.push(`checks changed for "${contract.id}" between plan acceptance and verification — the work is no longer the one agreed`);
    }
  }

  return { problems, appeared };
}

/**
 * Persist the seal after enrolling files that appeared during the run.
 * Absent-at-acceptance files created mid-run are enrolled at first check,
 * so a *later* rewrite of them is a modification — not just "another file
 * appeared". This is the difference between catching the orchestrator's
 * spec edit at re-verify time and describing it forever as benign.
 *
 * Records are mutated in place by `checkEvidence` before this is called, so
 * this only writes what the loop already enrolled.
 */
function persistEnrollment(directory: string, manifest: EvidenceManifest, appeared: string[]): void {
  if (appeared.length === 0) return;
  try {
    writeFileSync(join(directory, EVIDENCE_FILE), JSON.stringify(manifest, null, 2));
  } catch (error) {
    process.stderr.write(`[cubicore] evidence seal enrollment could not be written: ${String(error).slice(0, 200)}\n`);
  }
}

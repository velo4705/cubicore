import { readFileSync } from "node:fs";

import type { Artifact, Contract, Design } from "../contracts/types";
import { effectiveMatrix } from "../validate/matrix";
import type { Check } from "../contracts/types";

/**
 * The three gates, run in order, stopping at the first failure.
 *
 * Ordering is not arbitrary. `schema` must come first because a malformed
 * artifact cannot be verified — there is nothing to run a command against. That
 * also means one retry re-runs the whole chain rather than just the failed
 * gate, because a schema retry produces a *different* artifact.
 */

export type GateName = "schema" | "verify" | "scope" | "style" | "role";

export interface GateResult {
  gate: GateName;
  passed: boolean;
  detail: string;
  /** Only blocking ∧ convergent failures may trigger a revise round. */
  retryable: boolean;
  /**
   * True when the check could not run at all -- a missing tool, an unavailable
   * dependency. Not a failure, and not a pass: no evidence either way.
   */
  unverified?: boolean;
}

/** Provided by the host, so this module never shells out itself. */
export interface CommandRunner {
  run(command: string): Promise<{ exitCode: number; output: string }>;
}

export interface GateOptions {
  /** Files the worker actually modified, for the scope gate. */
  changedFiles: readonly string[];
  /**
   * The union of every contract's declared writes in the plan.
   *
   * opencode v2 cannot attribute a file to a worker — per-session diff and
   * file.edited both miss or leak across sessions — so a per-worker scope
   * verdict is not available on this host. The run is judged against the
   * union instead: any file changed outside every declared write flags the
   * worker and the run. It cannot name the author, and it does not need
   * to.
   */
  unionWrites?: readonly string[];
  /**
   * True when the changed-file list could not be determined at all.
   *
   * This is not the same as "the worker changed nothing". Without the
   * distinction a scope gate that learned nothing reports success -- the
   * failure is silent and the report says the scope was respected.
   */
  changesUnknown?: boolean;
  /** The workspace root the gate may read files from, for style checks. */
  root?: string;
  /** The plan's declared design (palette and friends). */
  design?: Design;
}

/** Minimal artifact shape every gate reads. Never a transcript. */
export interface GateInput {
  artifact: Artifact;
  contract: Contract;
  baseline?: readonly Check[];
}

export function gateSchema({ artifact, contract }: GateInput): GateResult {
  const raw = artifact.raw;

  if (raw.trim().length === 0) {
    return {
      gate: "schema",
      passed: false,
      detail: "artifact was empty",
      retryable: true,
    };
  }

  const structured = contract.deliverable !== "diff";
  if (!structured) {
    return {
      gate: "schema",
      passed: true,
      detail: "diff deliverable accepted as text",
      retryable: false,
    };
  }

  try {
    JSON.parse(raw);
    return {
      gate: "schema",
      passed: true,
      detail: "artifact parsed against the contract schema",
      retryable: false,
    };
  } catch (error) {
    return {
      gate: "schema",
      passed: false,
      detail: `artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    };
  }
}

/**
 * Runs every blocking ∧ convergent check. Advisory and non-convergent checks are
 * recorded by the caller but never gate, because neither can be satisfied by
 * one revision.
 */
export async function gateVerify(
  input: GateInput,
  runner: CommandRunner,
): Promise<GateResult> {
  const { contract, baseline = [] } = input;
  const matrix = effectiveMatrix(baseline, contract.checks);
  const blocking = matrix.filter(
    (check) => check.gating === "blocking" && check.convergent,
  );

  for (const check of blocking) {
    let result: { exitCode: number; output: string };
    try {
      result = await runner.run(check.command);
    } catch (error) {
      return {
        gate: "verify",
        passed: false,
        detail: `check "${check.id}" could not run: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      };
    }

    if (result.exitCode !== 0) {
      // A check that could not run is not a check that failed. A missing tool
      // or an unavailable dependency will fail the same way every time, so it
      // is unverified, not broken -- and it is not retryable, because a
      // revision cannot install a dependency.
      if (!couldRun(result)) {
        return {
          gate: "verify",
          passed: false,
          unverified: true,
          detail:
            `check "${check.id}" could not run (exit ${result.exitCode}): ` +
            `${result.output.slice(0, 400)}. Treated as unverified, not as a failure.`,
          retryable: false,
        };
      }
      return {
        gate: "verify",
        passed: false,
        detail: `check "${check.id}" exited ${result.exitCode}: ${result.output.slice(0, 500)}`,
        retryable: true,
      };
    }
  }

  return {
    gate: "verify",
    passed: true,
    detail: `${blocking.length} blocking check(s) passed`,
    retryable: false,
  };
}

/**
 * The safety gate: did the worker stay inside its declared write scope?
 *
 * This is the runtime counterpart to the plan-time disjointness check. The
 * validator proves two contracts don't *plan* to collide; this proves a worker
 * didn't write where it said it wouldn't, which is the case permission globs
 * may not catch (a tool path outside the glob grammar, a shell redirect).
 */
/**
 * Did the check actually run?
 *
 * 126 and 127 are the shell's "cannot execute" and "command not found", and
 * the message tells the same story when a runtime is missing. A check that
 * never started has produced no evidence either way, which is a different
 * fact from one that ran and found a problem.
 */
function couldRun(result: { exitCode: number; output: string }): boolean {
  if (result.exitCode === 126 || result.exitCode === 127) return false;
  const output = result.output.toLowerCase();
  return !(
    output.includes("command not found") ||
    output.includes("no such file or directory") ||
    output.includes("cannot find module") ||
    output.includes("is not recognized")
  );
}

export function gateScope(
  input: GateInput,
  options: GateOptions,
): GateResult {
  const { contract } = input;

  // The changes could not be determined. This is not a pass, and it is not a
  // scope violation either -- it is an absence of evidence, and it must not
  // be reported as evidence of safety.
  if (options.changesUnknown) {
    return {
      gate: "scope",
      passed: false,
      detail:
        "could not determine which files the worker changed, so the scope could not " +
        "be verified. This is not a scope violation, but it is not a pass either.",
      retryable: false,
    };
  }

  // A diff deliverable that changed nothing did not do the work. Reporting a
  // pass here is how a broken worker passes a green gate.
  if (options.changedFiles.length === 0 && contract.deliverable === "diff") {
    return {
      gate: "scope",
      passed: false,
      detail:
        "worker changed no files, but the contract's deliverable is a diff, so the " +
        "work was not done",
      retryable: true,
    };
  }

  const stray = options.changedFiles.filter(
    (file) => !contract.writes.some((glob) => glob === file || glob === "**" || matchesGlob(glob, file)),
  );

  if (stray.length === 0) {
    return {
      gate: "scope",
      passed: true,
      detail: `all ${options.changedFiles.length} changed file(s) inside declared writes`,
      retryable: false,
    };
  }

  return {
    gate: "scope",
    passed: false,
    detail: `worker modified undeclared path(s): ${stray.slice(0, 5).join(", ")}`,
    retryable: false,
  };
}

/**
 * The union scope gate — what the dispatcher runs.
 *
 * On hosts without per-worker attribution, every worker reports (at least)
 * the union of the team's changes. Failing that, a healthy run of
 * disjoint contracts was reported as N symmetric scope violations and the
 * work was discarded — the founder's plan did exactly what it said and was
 * flagged for it. This gate asks one question with evidence behind it:
 * did anything land outside every declared write in the plan? If the plan
 * declared nothing, nothing is allowed to land.
 */

/** True when the file is an artefact of Cubicore's own dispatch, not worker output. */
function isDispatchArtefact(file: string): boolean {
  const normalised = file.replace(/^\.\//, "");
  return normalised.startsWith(".cubicore/");
}

export function gateUnionScope(
  input: GateInput,
  options: GateOptions,
): GateResult {
  if (options.changesUnknown) {
    return {
      gate: "scope",
      passed: false,
      detail:
        "could not determine which files the run changed, so the scope could not " +
        "be verified. Not a scope violation, and not a pass either.",
      retryable: false,
    };
  }

  const unionWrites = options.unionWrites ?? input.contract.writes;

  if (options.changedFiles.length === 0 && input.contract.deliverable === "diff") {
    return {
      gate: "scope",
      passed: false,
      detail:
        "the run changed no files, but the contract's deliverable is a diff, so the " +
        "work was not done",
      retryable: true,
    };
  }

  // Event attribution could (unverified, host-dependent) report paths under
  // .cubicore/worktrees/<id> — i.e. internal dispatch artefacts, not product
  // files the plan ever declares. If a framework/discipline artefact shows up
  // it must not be counted as an out-of-scope production edit.
  const stray = options.changedFiles.filter(
    (file) =>
      !isDispatchArtefact(file) &&
      !unionWrites.some((glob) => glob === file || glob === "**" || matchesGlob(glob, file)),
  );

  if (stray.length === 0) {
    return {
      gate: "scope",
      passed: true,
      detail: `all ${options.changedFiles.length} changed file(s) inside the plan's declared scopes`,
      retryable: false,
    };
  }

  return {
    gate: "scope",
    passed: false,
    detail: `worker(s) changed file(s) outside every declared write in the plan: ${stray.slice(0, 5).join(", ")}`,
    retryable: false,
  };
}


/**
 * The role gate — advisory only.
 *
 * opencode 2.1.3 does not attribute file or tool events to sessions, so there
 * is no run-time signal a role can be held to here. A tool policy enforced
 * only after the damage is done is not enforcement: it is a letter. So on
 * this host the gate's verdict is always "pass — not verifiable on this
 * host; advisory only", reported as such. On a host with attributed events
 * (e.g. via an event stream matched to the session id), the same gate
 * enforces what the role declared and flags violations instead of passing
 * everything through.
 */
export function gateRole(input: GateInput, _options?: GateOptions): GateResult {
  const role = input.contract.role;
  if (!role) {
    return { gate: "role", passed: true, detail: "no role declared — advisory absent", retryable: false };
  }
  const deny = (role.tools?.deny?.length ?? 0) > 0;
  const handoff = !!role.handoff;
  return {
    gate: "role",
    passed: true,
    detail: [
      `role "${role.name}" — advisory only on this host (no file or tool events are attributed to sessions).`,
      deny ? `declared tool deny: ${(role.tools?.deny ?? []).join(", ")} — not enforceable here.` : "no tool deny declared.",
      handoff ? `handoff owes ${role.handoff!.deliverable} for ${role.handoff!.audience} — checked only by the plan author before dispatch.` : "no handoff artifact declared.",
    ].join(" "),
    retryable: false,
  };
}

/**
 * Single-segment-agnostic glob. `*` spans `/`, matching opencode's own resource
 * semantics, so `src/*` legitimately covers `src/a/b.ts`.
 */
export function matchesGlob(glob: string, path: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*\*/g, " ").replace(/\*/g, "[^]*").replace(/ /g, "[^]*");
  try {
    return new RegExp(`^${pattern}$`).test(path);
  } catch {
    return glob === path;
  }
}

/**
 * The palette gate.
 *
 * Scans the worker's changed files for raw hex colors and requires every
 * one to appear in the plan's declared palette. The palette is a small,
 * closed set of hexes chosen by the founder at review; a worker that picks
 * its own colors is not an aesthetic choice, it is a contract violation.
 *
 * Not-written checks that cannot run are unverified rather than passed,
 * consistent with the scope gate's rule.
 */
export function gateStyle(
  input: GateInput,
  options: GateOptions,
): GateResult {
  const design = options.design;
  if (!design) {
    return { gate: "style", passed: true, detail: "no design declared for this plan; style gate skipped", retryable: false };
  }
  if (options.changesUnknown || !options.root) {
    return {
      gate: "style",
      passed: false,
      detail: options.root
        ? "could not enumerate changed files, so the palette could not be verified"
        : "no workspace root provided; the palette check needs to read the changed files",
      retryable: false,
      unverified: true,
    };
  }

  const palette = new Set(design.palette.map(normalizeHex));
  const seen = new Map<string, string>(); // undeclared -> first file seen in
  for (const file of options.changedFiles) {
    const full = `${options.root.replace(/\/+$/, "")}/${file}`;
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      return { gate: "style", passed: false, detail: `could not read ${file} to scan it`, retryable: false, unverified: true };
    }
    for (const raw of content.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const hex = normalizeHex(raw[0]);
      // Allow lengths that expand cleanly (3, 4, 6, 8).
      if (![3, 4, 6, 8].includes(raw[0].length - 1)) continue;
      if (!palette.has(hex) && !seen.has(hex)) {
        seen.set(hex, file);
      }
    }
  }

  if (seen.size === 0) {
    return { gate: "style", passed: true, detail: `no hex color in the diff falls outside the declared palette`, retryable: false };
  }
  const offenders = [...seen.entries()].map(([hex, file]) => `${hex} (in ${file})`).slice(0, 6).join(", ");
  return {
    gate: "style",
    passed: false,
    detail: `colors outside the declared palette: ${offenders}`,
    retryable: true,
  };
}

function normalizeHex(hex: string): string {
  let h = hex.replace(/^#/, "").toLowerCase();
  if (h.length === 3 || h.length === 4) {
    h = h.split("").map((c) => c + c).join("");
  }
  if (h.length === 4) h = h + "ff"; // treat as #RGBA
  return `#${h}`;
}

/** Runs the chain and returns the first failure, or a pass. */
export async function runGates(
  input: GateInput,
  runner: CommandRunner,
  options: GateOptions,
): Promise<GateResult[]> {
  const results: GateResult[] = [];

  const schema = gateSchema(input);
  results.push(schema);
  if (!schema.passed) return results;

  const verify = await gateVerify(input, runner);
  results.push(verify);
  if (!verify.passed) return results;

  // Union across the plan, not per worker: attribution is not available
  // on this host, and failing to see it must not punish a clean plan.
  const scope = gateUnionScope(input, options);
  results.push(scope);
  if (!scope.passed) return results;

  results.push(gateStyle(input, options));
  results.push(gateRole(input, options));
  return results;
}
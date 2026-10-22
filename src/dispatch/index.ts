import type { Check, Contract, Plan, WorkerResult } from "../contracts/types";
import { workerPermissions } from "../adapters/opencode/permissions";
import { runGates, type CommandRunner, type GateResult } from "../gate";
import { effectiveMatrix } from "../validate/matrix";
import { BudgetLedger, admit, type Caps } from "./budgets";
import { deriveCaps } from "./budgets";
import { gate as noveltyGate, review, type ReviewFinding } from "../review";
import { stages } from "../coordinator/topology";

/** Supplies repo state so the reviewer can diff it across the revise round. */
export interface RepoSnapshotSource {
  /** Resolve the anchors of the given check commands. */
  anchors(commands: readonly string[]): ReadonlyMap<string, string>;
  /** Enumerate test files currently on disk. */
  testFiles(): readonly string[];
}

/**
 * The dispatch driver.
 *
 * Deliberately an interface, not an opencode call. Everything testable about
 * dispatch — fan-out shape, admission, retry budget, gate sequencing, how a
 * failure is annotated — lives here and needs no provider. The opencode-specific
 * spawn is one adapter to write in Phase 2's final step.
 */

export interface WorkerRunner {
  /** `attempt` is 0 on the first run and 1 on the revise round. */
  run(contract: Contract, attempt?: number): Promise<WorkerResult>;
}

export interface DispatchOutcome {
  /**
   * Why the dispatch stopped early, if it did.
   *
   * Without this a cancelled run looks exactly like a finished one: the
   * dispatch breaks out of the stage loop and returns, and the caller records
   * it as done. A cancel that reports success is the same class of lie as a
   * gate that passes because it learned nothing.
   */
  halted: "cancelled" | "paused" | null;
  accepted: WorkerResult[];
  failed: { contractId: string; result: WorkerResult; gates: GateResult[] }[];
  unresolved: string[];
  /** Contracts the graph budget could not fund. */
  deferred: string[];
  budgetExhausted: boolean;
  /**
   * Bar-integrity findings from the revise round. These are *not* revision
   * triggers — the revise cap is already spent — so they go straight to
   * aggregation as unresolved.
   */
  reviewFindings: ReviewFinding[];
}

export interface DispatchOptions {
  /**
   * Contracts an earlier run already satisfied, unchanged.
   *
   * Ids only, and only for contracts the caller has confirmed are identical
   * to the ones that passed. A refine that adds a feature produces a plan
   * containing every contract, and dispatching all of them re-runs the ones
   * that already worked.
   */
  satisfiedContracts?: readonly string[];
  /**
   * Reports whether the run has been cancelled or paused.
   *
   * Checked between stages. A cancel that only records the request without
   * stopping the dispatch would be the same class of lie as a gate that
   * passes because it learned nothing.
   */
  halt?: () => "cancelled" | "paused" | null;
  /**
   * Integrate a passed worker's work, and discard a failed one's.
   *
   * The lifecycle is: collect changes, check permissions, validate results,
   * then integrate the approved changes. Integration is last, and only for
   * what passed.
   */
  collect?: (contractId: string) => void;
  discard?: (contractId: string) => void;
  baseline?: readonly Check[];
  /** Revise rounds. One is the designed maximum (D6). */
  maxRetries?: number;
  gate?: CommandRunner;
  /** Caps derived per contract, for the caller to enforce via hooks. */
  caps?: (contract: Contract) => Caps;
  /** Enables bar-integrity review on the revise round. */
  repo?: RepoSnapshotSource;
  trace?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * One retry total, not one per gate.
 *
 * A schema failure means there is nothing to verify, so the retry produces a new
 * artifact and the whole chain re-runs. Allowing a retry per gate would mean up
 * to four worker invocations for one contract — a 4× cost against a headline
 * claim about cost control. One retry bounds it at 2×.
 */
export function shouldRetry(gates: GateResult[]): boolean {
  const failure = gates.find((gate) => !gate.passed);
  return failure?.retryable === true;
}

export async function dispatch(
  plan: Plan,
  runner: WorkerRunner,
  gateRunner: CommandRunner,
  options: DispatchOptions = {},
): Promise<DispatchOutcome> {
  const maxRetries = options.maxRetries ?? 1;
  const accepted: WorkerResult[] = [];
  const failed: DispatchOutcome["failed"] = [];
  const unresolved: string[] = [];
  const reviewFindings: ReviewFinding[] = [];

  // Admission before dispatch: a contract the graph budget cannot fund is not
  // run at all, rather than run and truncated (D8).
  const ledger = new BudgetLedger(plan.graphBudget);
  const { admitted, deferred } = admit(plan.contracts, ledger);

  // Contracts a previous run already satisfied are not run again.
  //
  // Refining a plan to add a feature is the common case, and the plan it
  // produces contains every contract -- the eight that passed and the two
  // that are new. Dispatching all ten re-runs the eight for nothing, which
  // is five times the spend on the second cycle.
  //
  // A contract is skipped only when it is unchanged: same id, same write
  // scope, same checks, and it passed last time. If the refine touched it,
  // it runs again.
  const satisfied = options.satisfiedContracts ?? [];
  const fresh = admitted.filter((c) => !satisfied.includes(c.id));
  const reused = admitted.filter((c) => satisfied.includes(c.id));

  options.trace?.("dispatch.admitted", {
    admitted: fresh.length,
    deferred: deferred.length,
    reused: reused.length,
  });

  for (const contract of reused) {
    unresolved.push(
      `${contract.id} — not re-run: unchanged and already satisfied by an earlier run`,
    );
  }

  for (const contract of deferred) {
    unresolved.push(
      `${contract.id} — deferred: graph budget could not fund this contract`,
    );
  }

  // Contracts run in dependency stages. A contract that reads what another
  // writes -- a route importing the shared types, a dispatcher importing the
  // routes -- cannot be verified until the producer has landed. Running the
  // whole plan at once made every such check fail on a module that simply had
  // not been written yet, and the revise round then re-ran the work to fix a
  // race. The plan already declares the ordering; the executor has to honour
  // it.
  //
  // Within a stage the contracts are independent by construction, so they
  // still run in parallel.
  const pipeline = stages(plan.contracts);
  const stageOf = new Map<string, number>();
  for (const stage of pipeline.stages) {
    for (const contract of stage.contracts) stageOf.set(contract.id, stage.index);
  }

  const settled: Array<{ contract: Contract; result: WorkerResult; gates: GateResult[]; passed: boolean }> = [];
  let halted: "cancelled" | "paused" | null = null;

  for (const stage of pipeline.stages) {
    const batch = fresh.filter((c) => stageOf.get(c.id) === stage.index);
    if (batch.length === 0) continue;

    // A cancelled or paused run stops here. Checked between stages, so
    // cancelling actually stops the spending rather than only recording
    // that it was asked to.
    const halt = options.halt?.();
    if (halt === "cancelled") {
      for (const contract of batch) {
        unresolved.push(`${contract.id} — skipped: the run was cancelled`);
      }
      halted = "cancelled";
      break;
    }
    if (halt === "paused") {
      for (const contract of batch) {
        unresolved.push(`${contract.id} — deferred: the run was paused`);
      }
      halted = "paused";
      break;
    }

    const results = await Promise.all(
      batch.map(async (contract) => {
      let result = await runner.run(contract);
      let gates: GateResult[] = [];

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        gates = await runGates(
          { artifact: result.artifact ?? emptyArtifact(contract), contract, baseline: options.baseline },
          gateRunner,
          { changedFiles: result.changedFiles, changesUnknown: result.changesUnknown },
        );

        const passed = gates.every((gate) => gate.passed);
        options.trace?.("dispatch.gates", {
          contractId: contract.id,
          attempt,
          passed,
          gates: gates.map((g) => `${g.gate}:${g.passed ? "ok" : "fail"}`),
        });

        // Integrate only what passed. A worker whose checks failed keeps its
        // work in its own worktree, so an unapproved change never reaches the
        // shared tree -- and when it retries, it retries from a clean copy.
        if (passed) {
          options.collect?.(contract.id);
          return { contract, result, gates, passed };
        }

        if (!shouldRetry(gates) || attempt === maxRetries) {
          options.discard?.(contract.id);
          return { contract, result, gates, passed };
        }

        // Snapshot the bar before the worker gets another chance at it. This is
        // the only moment the worker has an incentive to weaken a check, so it
        // is the only moment the review is worth spending.
        const before = options.repo
          ? {
              anchors: options.repo.anchors(blockingCommands(contract, options.baseline)),
              tests: [...options.repo.testFiles()],
            }
          : null;

        // The retry is the only moment a stronger model can change the
        // outcome, so the attempt number is passed down and routing escalates
        // rather than the first attempt paying frontier tokens.
        // The failed attempt's work is not integrated and is not carried
        // forward: the retry starts from the baseline, so a change that broke
        // a check cannot be inherited by the attempt that fixes it.
        options.discard?.(contract.id);
        result = await runner.run(contract, attempt + 1);

        if (before && options.repo) {
          const findings = noveltyGate(
            review({
              contract,
              anchorsBefore: before.anchors,
              anchorsAfter: options.repo.anchors(
                blockingCommands(contract, options.baseline),
              ),
              testFilesBefore: before.tests,
              testFilesAfter: [...options.repo.testFiles()],
            }),
          );
          reviewFindings.push(...findings);
        }
      }

      return { contract, result, gates, passed: false };
      }),
    );

    settled.push(...results);
  }

  for (const { contract, result, gates, passed } of settled) {
    if (passed) {
      accepted.push(result);
      continue;
    }

    const summary = gates
      .filter((gate) => !gate.passed)
      .map((gate) => `${gate.gate}: ${gate.detail}`)
      .join("; ");

    unresolved.push(`${contract.id} — ${summary}`);
    failed.push({ contractId: contract.id, result, gates });
  }

  return {
    accepted,
    failed,
    halted,
    unresolved,
    deferred: deferred.map((contract) => contract.id),
    budgetExhausted: ledger.exhausted,
    reviewFindings,
  };
}

/** Blocking, convergent check commands — the ones worth protecting. */
function blockingCommands(
  contract: Contract,
  baseline?: readonly Check[],
): string[] {
  return effectiveMatrix(baseline ?? [], contract.checks)
    .filter((check) => check.gating === "blocking" && check.convergent)
    .map((check) => check.command);
}

function emptyArtifact(contract: Contract) {
  return { contractId: contract.id, deliverable: contract.deliverable, raw: "" };
}

/** Permissions for a whole plan, keyed by contract id. */
export function planPermissions(plan: Plan): Record<string, ReturnType<typeof workerPermissions>> {
  return Object.fromEntries(
    plan.contracts.map((contract) => [contract.id, workerPermissions(contract)]),
  );
}
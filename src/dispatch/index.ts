import type { Check, Contract, Plan, WorkerResult } from "../contracts/types";
import { workerPermissions } from "./permissions";
import { runGates, type CommandRunner, type GateResult } from "../gate";
import { effectiveMatrix } from "../validate/matrix";
import { BudgetLedger, admit, type Caps } from "./budgets";
import { deriveCaps } from "./budgets";
import { gate as noveltyGate, review, type ReviewFinding } from "../review";

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

  options.trace?.("dispatch.admitted", { admitted: admitted.length, deferred: deferred.length });

  for (const contract of deferred) {
    unresolved.push(
      `${contract.id} — deferred: graph budget could not fund this contract`,
    );
  }

  // Fan-out: every admitted contract runs, because a shared workspace means an
  // early failure does not release a lock anyone else was waiting on.
  const settled = await Promise.all(
    admitted.map(async (contract) => {
      let result = await runner.run(contract);
      let gates: GateResult[] = [];

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        gates = await runGates(
          { artifact: result.artifact ?? emptyArtifact(contract), contract, baseline: options.baseline },
          gateRunner,
          { changedFiles: result.changedFiles },
        );

        const passed = gates.every((gate) => gate.passed);
        options.trace?.("dispatch.gates", {
          contractId: contract.id,
          attempt,
          passed,
          gates: gates.map((g) => `${g.gate}:${g.passed ? "ok" : "fail"}`),
        });
        if (passed) return { contract, result, gates, passed };

        if (!shouldRetry(gates) || attempt === maxRetries) {
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
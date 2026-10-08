import type { Contract, Plan, WorkerResult } from "../contracts/types";
import { workerPermissions } from "./permissions";
import { runGates, type CommandRunner, type GateResult } from "../gate";

/**
 * The dispatch driver.
 *
 * Deliberately an interface, not an opencode call. Everything testable about
 * dispatch — fan-out shape, retry budget, gate sequencing, how a failure is
 * annotated — lives here and needs no provider. The opencode-specific spawn is
 * one adapter to write in Phase 2's final step.
 */

export interface WorkerRunner {
  run(contract: Contract): Promise<WorkerResult>;
}

export interface DispatchOutcome {
  accepted: WorkerResult[];
  failed: { contractId: string; result: WorkerResult; gates: GateResult[] }[];
  unresolved: string[];
}

export interface DispatchOptions {
  baseline?: readonly Contract["checks"][number][];
  /** Revise rounds. One is the designed maximum (D6). */
  maxRetries?: number;
  gate?: CommandRunner;
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

  // Fan-out: every contract runs, because a shared workspace means an early
  // failure does not release a lock anyone else was waiting on.
  const settled = await Promise.all(
    plan.contracts.map(async (contract) => {
      let result = await runner.run(contract);
      let gates: GateResult[] = [];

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        gates = await runGates(
          { artifact: result.artifact ?? emptyArtifact(contract), contract, baseline: options.baseline },
          gateRunner,
          { changedFiles: result.changedFiles },
        );

        const passed = gates.every((gate) => gate.passed);
        if (passed) return { contract, result, gates, passed };

        if (!shouldRetry(gates) || attempt === maxRetries) {
          return { contract, result, gates, passed };
        }
        result = await runner.run(contract);
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

  return { accepted, failed, unresolved };
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
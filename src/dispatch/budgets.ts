import type { Contract, GraphBudget } from "../contracts/types";
import type { TokenUsage } from "../telemetry/types";

/**
 * Budgets, derived and enforced.
 *
 * Two halves, and they are not equally strong:
 *
 * - **Caps** (`deriveCaps`) are enforceable through opencode hooks, so they are
 *   hard stops. This is where the real cost control lives.
 * - **Admission** (`BudgetLedger`) is an up-front filter: it decides which
 *   contracts to dispatch when the graph budget cannot cover all of them.
 *
 * Admission is *not* mid-run interruption. A contract admitted at t=0 can still
 * overrun at t=30s, because the fan-out starts everything at once. Real
 * interruption needs the `tool.execute.before` and `chat.params` hooks, and
 * mid-run token accounting is only advisory — by the time the spend is visible,
 * it has already happened.
 *
 * `edges` is validated at plan time and not tracked here. It describes topology,
 * which is fixed once the plan exists.
 */

export const OUTPUT_SHARE = 0.4;
export const MIN_OUTPUT_TOKENS = 1_000;
export const MAX_OUTPUT_TOKENS = 32_000;

export interface Caps {
  maxOutputTokens: number;
  maxToolCalls: number;
  wallMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Output gets a share of the total, bounded at both ends.
 *
 * The floor matters: a contract whose budget is tiny still has to be able to
 * emit a diff, and a zero cap would fail every gate for a reason that has
 * nothing to do with the work.
 */
export function deriveCaps(contract: Contract): Caps {
  return {
    maxOutputTokens: clamp(
      Math.floor(contract.budget.tokens * OUTPUT_SHARE),
      MIN_OUTPUT_TOKENS,
      MAX_OUTPUT_TOKENS,
    ),
    maxToolCalls: contract.budget.toolCalls,
    wallMs: contract.budget.wallMs,
  };
}

export interface BudgetSnapshot {
  nodesUsed: number;
  tokensUsed: number;
  wallMsUsed: number;
  remainingNodes: number;
  remainingTokens: number;
  exhausted: boolean;
}

/**
 * Graph-level budget (D8). Admits work until it cannot, then stops rather than
 * overspending — graceful degradation beats runaway spend.
 */
export class BudgetLedger {
  private nodesUsed = 0;
  private tokensUsed = 0;
  private wallMsUsed = 0;

  constructor(private readonly budget: GraphBudget) {}

  /** Would this contract fit, assuming everything already running finishes? */
  admits(contract: Contract): boolean {
    if (this.nodesUsed + 1 > this.budget.nodes) return false;
    if (this.tokensUsed + contract.budget.tokens > this.budget.tokens) return false;
    return true;
  }

  admit(contract: Contract): boolean {
    if (!this.admits(contract)) return false;
    this.nodesUsed++;
    this.tokensUsed += contract.budget.tokens;
    return true;
  }

  /** Reserve the wall time up front too, so contracts cannot collectively overrun. */
  admitWithWallTime(contract: Contract): boolean {
    if (this.wallMsUsed + contract.budget.wallMs > this.budget.wallMs) return false;
    if (!this.admit(contract)) return false;
    this.wallMsUsed += contract.budget.wallMs;
    return true;
  }

  record(usage: TokenUsage, ms: number): void {
    this.tokensUsed += usage.input + usage.output + usage.reasoning;
    this.wallMsUsed += ms;
  }

  get exhausted(): boolean {
    return this.nodesUsed >= this.budget.nodes || this.tokensUsed >= this.budget.tokens;
  }

  snapshot(): BudgetSnapshot {
    return {
      nodesUsed: this.nodesUsed,
      tokensUsed: this.tokensUsed,
      wallMsUsed: this.wallMsUsed,
      remainingNodes: Math.max(0, this.budget.nodes - this.nodesUsed),
      remainingTokens: Math.max(0, this.budget.tokens - this.tokensUsed),
      exhausted: this.exhausted,
    };
  }
}

/**
 * Splits a plan into what the budget will fund and what it will not.
 *
 * Contracts are considered in plan order rather than cost order, because the
 * planner's ordering encodes dependency: dropping a cheap contract that a later
 * one depends on saves less than it appears to.
 */
export function admit(
  contracts: readonly Contract[],
  ledger: BudgetLedger,
): { admitted: Contract[]; deferred: Contract[] } {
  const admitted: Contract[] = [];
  const deferred: Contract[] = [];

  for (const contract of contracts) {
    if (ledger.admitWithWallTime(contract)) admitted.push(contract);
    else deferred.push(contract);
  }

  return { admitted, deferred };
}

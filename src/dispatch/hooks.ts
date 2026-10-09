import type { Caps } from "./budgets";

/**
 * Budget enforcement through opencode hooks.
 *
 * Three mechanisms, and they are not equally trustworthy. Each one's confidence
 * is recorded here rather than averaged away:
 *
 * | Mechanism | Hook | Status |
 * |---|---|---|
 * | Output token cap | `chat.params` | **verified** — `maxOutputTokens` is mutable, a hard cap |
 * | Tool-call cap | `tool.execute.before` | **advisory** — VERIFIED: output is `{ args }`, no veto exists |
 * | Session cancel | `session.abort` | **verified** — `POST /session/{id}/abort` exists |
 *
 * The pattern: implement all three, isolate the uncertain step in one function
 * each, and never let an unverified path silently look enforced. `deny` below
 * and `SessionSpawner.cancel` are the only two places that need checking.
 */

export interface SessionCaps {
  sessionId: string;
  contractId: string;
  caps: Caps;
  toolCalls: number;
  /** Set once a cap is hit; every later call is refused. */
  capped: boolean;
  /** True when a cap stopped the session rather than merely being exceeded. */
  stopped: boolean;
}

export interface ToolDecision {
  allow: boolean;
  reason?: string;
}

export interface Overrun {
  contractId: string;
  sessionId: string;
  kind: "tool-calls" | "output-tokens" | "wall-clock";
  limit: number;
}

/** The documented shape of `chat.params` output. Only this field is written. */
export interface ChatParamsOutput {
  maxOutputTokens?: number;
}

/** The documented shape of `tool.execute.before`. No status field is documented. */
export interface ToolBeforeOutput {
  args: unknown;
  status?: string;
}

/**
 * Tracks per-session caps and answers the budget hooks.
 *
 * Sessions register on creation and release on completion, so a long-lived
 * plugin process does not accumulate caps for finished runs.
 */
export class BudgetEnforcer {
  private readonly sessions = new Map<string, SessionCaps>();
  private readonly overruns: Overrun[] = [];

  register(sessionId: string, contractId: string, caps: Caps): void {
    this.sessions.set(sessionId, {
      sessionId,
      contractId,
      caps,
      toolCalls: 0,
      capped: false,
      stopped: false,
    });
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  activeSessions(): number {
    return this.sessions.size;
  }

  overrunsFor(): Overrun[] {
    return [...this.overruns];
  }

  /**
   * Caps output tokens for a session.
   *
   * Only ever *tightens*. If opencode already has a lower cap in place — from
   * the agent config or `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` — raising it
   * to a contract's budget would be the plugin loosening a limit the user set.
   */
  chatParams(
    input: { sessionID: string },
    output: ChatParamsOutput,
  ): void {
    const session = this.sessions.get(input.sessionID);
    if (!session) return;

    const cap = session.caps.maxOutputTokens;
    const current = output.maxOutputTokens;

    if (current === undefined || current > cap) {
      output.maxOutputTokens = cap;
    }
  }

  /**
   * Counts tool calls and refuses past the cap.
   *
   * The count and the decision are both here, so the accounting is right
   * regardless of whether the refusal can be enforced.
   */
  toolBefore(input: { sessionID: string; tool: string }): ToolDecision {
    const session = this.sessions.get(input.sessionID);
    if (!session) return { allow: true };

    if (session.capped) {
      return { allow: false, reason: "tool-call cap already reached for this session" };
    }

    session.toolCalls++;

    if (session.toolCalls > session.caps.maxToolCalls) {
      session.capped = true;
      this.overruns.push({
        contractId: session.contractId,
        sessionId: session.sessionId,
        kind: "tool-calls",
        limit: session.caps.maxToolCalls,
      });
      return {
        allow: false,
        reason: `tool-call cap of ${session.caps.maxToolCalls} exceeded`,
      };
    }

    return { allow: true };
  }

  /** Records that a session was stopped at its wall-clock ceiling. */
  recordWallClockOverrun(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.stopped = true;
    this.overruns.push({
      contractId: session.contractId,
      sessionId,
      kind: "wall-clock",
      limit: session.caps.wallMs,
    });
  }

  wasStopped(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.stopped ?? false;
  }
}

/**
 * The tool-call cap CANNOT be enforced. Checked against
 * `@opencode-ai/plugin@1.18.35`: `tool.execute.before` exposes only `{ args }`,
 * with no `status` field to write — unlike `permission.ask`, which does have
 * `{ status: "ask" | "deny" | "allow" }`. opencode provides no hook that can
 * stop an individual tool call.
 *
 * So this function is deliberately a no-op on the wire. It is kept because the
 * *decision* (`ToolDecision`) is what the report and the caller consume, and
 * because the moment opencode adds a veto field this is the one line that
 * needs changing. Until then the refusal is recorded and the call still runs.
 */
export function applyDenial(output: ToolBeforeOutput, decision: ToolDecision): void {
  if (decision.allow) return;
  output.status = "deny";
}
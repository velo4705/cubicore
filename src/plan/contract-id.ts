import type { Contract } from "../contracts/types";

/**
 * A stable identity for a contract across plan rewrites.
 *
 * Contract ids are chosen by the planner and can change when a plan is
 * refined. The work itself is identified by what it writes and how it is
 * checked. Those two facts survive a rewrite; the display id does not.
 * Objective prose is deliberately excluded: rewording a brief must not throw
 * away green work.
 */
export function contractFingerprint(contract: Contract): string {
  const writes = [...contract.writes].sort();
  const checks = contract.checks
    .map((c) => [c.id, c.command, c.gating, c.convergent] as const)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([contract.deliverable, writes, checks]);
}

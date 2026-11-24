import type { Plan } from "../contracts/types";

/**
 * A Full Product plan without an integration command can end with green
 * contracts and a broken merged tree. That is a real gap, but the founder
 * decided it is advisory: visual and integration judgements do not block a
 * run. Say it once, plainly, where the founder sees the verdict.
 */
export function integrationWarning(plan: Plan): string {
  if (plan.mode !== "full" || plan.integration) return "";
  return "Warning: this full plan has no top-level `integration` command. Contracts can pass while the merged tree stays unverified. Add `integration` before shipping.";
}

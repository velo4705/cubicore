import type { Contract } from "../../contracts/types";

/**
 * opencode V2 permission rules for one worker.
 *
 * VERIFY BEFORE TRUSTING: V2 uses the `permissions` array of
 * `{action, resource, effect}` rules, and `bash`/`task`/`permission` are V1
 * names that must not appear here. Written from the V2 permissions docs rather
 * than the installed SDK types; confirm the field names once `@opencode-ai/sdk`
 * is available.
 *
 * Two matching rules do the work, and both are favourable:
 *
 *  1. Last match wins, so broad rules go first and exceptions after.
 *  2. For a multi-file operation such as a patch, *any* matching deny denies
 *     the whole thing. That is a hard floor, not a tiebreak — so a worker
 *     cannot smuggle an undeclared file into a patch that also touches an
 *     allowed one.
 *
 * Rule 2 is why the broad deny is safe to place first.
 */

export type PermissionAction =
  | "read"
  | "edit"
  | "glob"
  | "grep"
  | "shell"
  | "subagent"
  | "webfetch"
  | "websearch";

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionRule {
  action: PermissionAction;
  resource: string;
  effect: PermissionEffect;
}

/**
 * Fail-closed by construction.
 *
 * A contract with a non-empty `writes` gets a deny-everything baseline and then
 * narrow allows. Anything the contract did not declare cannot be edited, which
 * is the runtime half of the disjointness guarantee `validatePlan` checks at
 * plan time — the validator catches collisions, this stops them.
 */
export function workerPermissions(contract: Contract): PermissionRule[] {
  const rules: PermissionRule[] = [];

  // Baseline: deny first, because last match wins and the allows must follow.
  rules.push({ action: "edit", resource: "*", effect: "deny" });

  for (const resource of contract.writes) {
    rules.push({ action: "edit", resource, effect: "allow" });
  }

  // Re-deny forbidden globs *after* the allows so they win the last match.
  for (const resource of contract.forbidden) {
    rules.push({ action: "edit", resource, effect: "deny" });
  }

  // Read scope is additive on top of the base policy rather than exhaustive:
  // a worker legitimately reads files outside its own write set, and denying
  // those would make most contracts unworkable. Forbidden paths are excluded.
  for (const resource of contract.forbidden) {
    rules.push({ action: "read", resource, effect: "deny" });
  }

  // Workers need to build and test, so shell is permitted. It is also the
  // weakest boundary here — a worker with shell can reach anything the user
  // can. Narrowing it to the contract's own check commands is the obvious next
  // tightening and is left for Phase 3, where budgets make the trade visible.
  rules.push({ action: "shell", resource: "*", effect: "allow" });

  // No recursion. A worker that could spawn workers would bypass the plan
  // validator entirely, which is the one thing the plan cannot afford.
  rules.push({ action: "subagent", resource: "*", effect: "deny" });

  return rules;
}

/** A tester finds problems it cannot fix, so it may not write at all. */
export function testerPermissions(reads: readonly string[]): PermissionRule[] {
  const rules: PermissionRule[] = [
    { action: "edit", resource: "*", effect: "deny" },
  ];

  for (const resource of reads) {
    rules.push({ action: "read", resource, effect: "allow" });
  }

  rules.push(
    { action: "shell", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
  );

  return rules;
}
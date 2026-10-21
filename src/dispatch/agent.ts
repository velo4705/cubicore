import type { Contract } from "../contracts/types";
import { workerPermissions, type PermissionRule } from "../adapters/opencode/permissions";

/**
 * A worker agent as plain data.
 *
 * No SDK types here on purpose. This is what opencode needs, expressed in
 * shapes this repo owns, so the translation to the real `Agent` config is one
 * adapter and the whole mapping stays testable.
 */

export interface AgentDefinition {
  name: string;
  mode: "subagent";
  /** Internal workers should not clutter the user's @-mention list. */
  hidden: boolean;
  description: string;
  prompt: string;
  /** V2 permission rules, in order. Last match wins. */
  permissions: PermissionRule[];
  model?: string;
}

export function agentId(contract: Contract): string {
  return `cubicore-${contract.id}`;
}

export function agentDefinition(
  contract: Contract,
  prompt: string,
  model?: string,
): AgentDefinition {
  return {
    name: agentId(contract),
    mode: "subagent",
    hidden: true,
    // This is what the coordinator reads when choosing a worker, so it should
    // say what the worker is for rather than repeat the objective verbatim.
    description: `Cubicore worker for: ${contract.objective}`,
    prompt,
    permissions: workerPermissions(contract),
    model,
  };
}

export function agentDefinitions(
  contracts: readonly Contract[],
  promptFor: (contract: Contract) => string,
  modelFor?: (contract: Contract) => string | undefined,
): AgentDefinition[] {
  return contracts.map((contract) =>
    agentDefinition(contract, promptFor(contract), modelFor?.(contract)),
  );
}

import { join } from "node:path";

import { ASSOCIATE_AGENT_ID, BRIEF_DIR, briefPath } from "./inline";
import type { Plan } from "../contracts/types";

/**
 * Instructions for the opt-in `dispatch: "host"` path. Cubicore cannot call
 * the host's sub-agent tool itself. This block asks the model to do it in one
 * tool block so the workers appear as inline chat rows, then to record the
 * run through Cubicore so the ledger and gates still happen.
 *
 * This path is model-controlled. It is opt-in because a model can collapse
 * the block into serial calls; the default `code` path does not have that
 * failure mode.
 */
export function hostDispatchInstructions(plan: Plan, directory: string): string {
  const lines = [
    "HOST SUBAGENT DISPATCH REQUIRED (this plan declares dispatch: host)",
    "",
    `Call the host's sub-agent tool ONCE with ${plan.contracts.length} tool call(s) in the SAME tool block, in parallel.`,
    `Use agent "${ASSOCIATE_AGENT_ID}" for every call.`,
    "HARD RULE: emit every call together. Do not dispatch one at a time, do not wait for one to finish",
    "before starting the next, and do not use a sequential loop. A single worker at a time is a failure",
    "of this mode, not a smaller version of it. If the host cannot emit all calls in one block, stop,",
    "say that plainly, and remove dispatch from the plan so Cubicore dispatches sessions in code.",
    "Give each call its own brief and work in its own directory. The briefs are:",
    "",
    ...plan.contracts.map((c, i) => `- ${c.id}: ${join(directory, briefPath(i, c.id))}`),
    "",
    "Wait for every report. Then call the `record_inline_run` tool with the reports so Cubicore re-runs",
    "every blocking check on disk and writes the ledger. Do not merge reports yourself.",
    "If the host cannot launch all calls in one block, say so plainly and run /cubicore:execute",
    "with dispatch removed from the plan so Cubicore dispatches sessions in code.",
  ].join("\n");
  return `${lines}\n\nBriefs are written to ${BRIEF_DIR}/ by dispatch_blueprint. If they are missing, call that tool first.`;
}

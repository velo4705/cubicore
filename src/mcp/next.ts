import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLAN_JSON, DEBUG_MD } from "./protocol";
import { loadRuns } from "./runs";

/**
 * What to do next.
 *
 * A founder who has to remember the order loses the thread, and the order is
 * not obvious: fix is only meaningful after a test found something, and execute
 * is wrong after a plan that was never written.
 *
 * But it is not one answer either. After a plan the founder may want to run
 * it, change it, or look at what it will cost first. Offering only the
 * recommended one takes that decision away from them; offering every command
 * is no help at all. So the state on disk decides which few are worth
 * offering, and the recommended one comes first.
 *
 * Read from the artefacts rather than tracked in memory, because the founder
 * may arrive days later, in a new session, with a half-finished project.
 */

export type NextStep =
  | "plan"
  | "execute"
  | "status"
  | "test"
  | "fix"
  | "deploy"
  | "refine"
  | "estimate"
  | "undo"
  | "done";

export const COMMAND: Record<NextStep, string> = {
  plan: "/cubicore:plan",
  execute: "/cubicore:execute",
  status: "/cubicore:status",
  test: "/cubicore:test",
  fix: "/cubicore:fix",
  deploy: "/cubicore:deploy",
  refine: "/cubicore:refine",
  estimate: "/cubicore:estimate",
  undo: "/cubicore:undo",
  done: "",
};

export interface Option {
  step: NextStep;
  /** What this one is for, in the founder's terms. */
  note: string;
  /** True for the one the system would do. */
  recommended?: boolean;
}

/** How many blocking findings the last test recorded. */
export function blockingFindings(directory: string): number {
  const path = join(directory, DEBUG_MD);
  if (!existsSync(path)) return 0;
  try {
    const text = readFileSync(path, "utf8");
    const match = /(\d+)\s+blocking/.exec(text);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * The steps worth offering, in the order they should be read.
 *
 * Each state offers the obvious one plus the two or three a founder
 * plausibly wants instead. Nothing else -- a list of nine commands is not
 * guidance.
 */
export function nextOptions(directory: string): Option[] {
  const planned = existsSync(join(directory, PLAN_JSON));
  const runs = loadRuns(directory);
  const latest = runs[0];

  if (!planned) {
    return [{ step: "plan", note: "there is no plan yet", recommended: true }];
  }

  if (!latest) {
    return [
      { step: "execute", note: "the plan is written and has not been dispatched", recommended: true },
      { step: "estimate", note: "see what it will cost first" },
      { step: "refine", note: "change the plan before running it" },
    ];
  }

  if (latest.state === "running") {
    return [{ step: "status", note: "a run is in flight", recommended: true }];
  }

  if (latest.state === "paused") {
    return [
      { step: "undo", note: "a run is paused; undo discards what it did", recommended: true },
      { step: "status", note: "see what it did before deciding" },
    ];
  }

  if (latest.state === "cancelled") {
    return [
      { step: "undo", note: "discard what the cancelled run changed", recommended: true },
      { step: "plan", note: "start over" },
    ];
  }

  // The run finished.
  if (blockingFindings(directory) > 0) {
    return [
      { step: "fix", note: "the test found blocking findings", recommended: true },
      { step: "refine", note: "change the plan instead" },
      { step: "undo", note: "discard the run and start over" },
    ];
  }

  if (!existsSync(join(directory, DEBUG_MD))) {
    return [
      { step: "test", note: "the run finished but nothing has been tested", recommended: true },
      { step: "refine", note: "change the plan instead" },
      { step: "undo", note: "discard the run and start over" },
    ];
  }

  // Everything passes.
  return [
    { step: "deploy", note: "everything passes; the project is ready to put somewhere", recommended: true },
    { step: "refine", note: "add another feature to what was built" },
    { step: "undo", note: "discard the run and start over" },
  ];
}

/** The recommended step on its own. */
export function nextStep(directory: string): NextStep {
  return nextOptions(directory)[0]?.step ?? "done";
}

/** The command on its own, for a reply that ends with it. */
export function nextCommand(directory: string): string {
  return COMMAND[nextStep(directory)];
}

/**
 * The block a reply ends with: the recommended command, then the alternatives.
 *
 * The founder reads the agent's reply, not the tool output, so this has to be
 * stated where it can be acted on -- which is why the prompts tell the agent
 * to pass it on rather than invent its own suggestion.
 */
export function nextLine(directory: string): string {
  const options = nextOptions(directory);
  if (options.length === 0) return "";

  const [first, ...rest] = options;
  const lines = [`Next: ${COMMAND[first.step]}  (${first.note})`];
  if (rest.length > 0) {
    lines.push(
      `Or: ${rest.map((o) => `${COMMAND[o.step]} (${o.note})`).join(" · ")}`,
    );
  }
  return lines.join("\n");
}

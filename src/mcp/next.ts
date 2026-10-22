import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLAN_JSON, DEBUG_MD } from "./protocol";
import { loadRuns } from "./runs";

/**
 * What to type next.
 *
 * A founder who has to remember the order loses the thread, and the order is
 * not obvious: fix is only meaningful after a test found something, and
 * execute is wrong after a plan that was never written. So the state is read
 * from the artifacts on disk and the next command is derived from it.
 *
 * The agent is told to end every reply with it, so the next step is always
 * visible without the founder remembering anything.
 */

export type NextStep =
  | "plan"
  | "execute"
  | "status"
  | "test"
  | "fix"
  | "deploy"
  | "refine"
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
  undo: "/cubicore:undo",
  done: "",
};

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
 * Derive the next step from what is on disk.
 *
 * Read from the artefacts rather than tracked in memory, because the founder
 * may arrive days later, in a new session, with a half-finished project.
 */
export function nextStep(directory: string): NextStep {
  const planned = existsSync(join(directory, PLAN_JSON));
  const runs = loadRuns(directory);
  const latest = runs[0];

  if (!planned) return "plan";

  if (!latest) return "execute";

  if (latest.state === "running") return "status";
  if (latest.state === "cancelled") return "undo";
  if (latest.state === "paused") return "status";

  // The run finished. If the test found something blocking, fix it; if the
  // test has not run yet, run it.
  if (blockingFindings(directory) > 0) return "fix";
  if (!existsSync(join(directory, DEBUG_MD))) return "test";

  // Clean. The project is done -- the next thing is putting it somewhere.
  return "deploy";
}

/** The command on its own, for a reply that ends with it. */
export function nextCommand(directory: string): string {
  const step = nextStep(directory);
  if (step === "done") return "";
  return COMMAND[step];
}

/** The whole line: the command and why. Empty when there is nothing to do. */
export function nextLine(directory: string): string {
  const command = nextCommand(directory);
  if (!command) return "";
  return `Next: ${command}  (${nextReason(directory)})`;
}

/** Why that step, in one line. */
export function nextReason(directory: string): string {
  switch (nextStep(directory)) {
    case "plan":
      return "there is no plan yet";
    case "execute":
      return "the plan is written and has not been dispatched";
    case "status":
      return "a run is in flight";
    case "test":
      return "the run finished but nothing has been tested yet";
    case "fix":
      return "the test found blocking findings";
    case "deploy":
      return "everything passes; the project is ready to put somewhere";
    case "undo":
      return "the last run was cancelled";
    default:
      return "";
  }
}

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blockingFindings, nextCommand, nextLine, nextOptions, nextStep } from "../src/mcp/next";
import { startRun } from "../src/mcp/runs";
import type { Plan } from "../src/contracts/types";

/**
 * The founder should never have to remember the order.
 *
 * The debug command only makes sense after work was delivered. Execute is wrong before
 * a plan exists. The next command is derived from what is on disk, so it
 * survives a restart and a new session.
 */

const dir = () => mkdtempSync(join(tmpdir(), "cubicore-next-"));
const plan = (): Plan =>
  ({
    topology: "fan-out",
    contracts: [
      {
        id: "a",
        objective: "Do the thing",
        reads: [],
        writes: ["src/a.ts"],
        forbidden: [],
        deliverable: "diff",
        schema: { type: "object" },
        doneWhen: "done",
        checks: [],
        budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
      },
    ],
    graphBudget: { nodes: 1, edges: 0, tokens: 1000, wallMs: 1000 },
  }) as Plan;

describe("the next step", () => {
  it("asks for a plan when there is none", () => {
    expect(nextStep(dir())).toBe("plan-demo");
  });

  it("asks to execute once the plan is written", () => {
    const d = dir();
    writeFileSync(join(d, "CUBICORE_PLAN.json"), "{}");
    expect(nextStep(d)).toBe("execute");
  });

  it("asks for the status while a run is in flight", () => {
    const d = dir();
    writeFileSync(join(d, "CUBICORE_PLAN.json"), "{}");
    startRun(plan(), d);
    expect(nextStep(d)).toBe("status");
  });

  it("asks to debug when the run finished but nothing was tested or debugged", () => {
    const d = dir();
    writeFileSync(join(d, "CUBICORE_PLAN.json"), "{}");
    const run = startRun(plan(), d);
    // Mark it finished.
    writeFileSync(
      join(d, ".cubicore", "runs.json"),
      JSON.stringify([{ ...run, state: "done" }]),
    );
    expect(nextStep(d)).toBe("debug");
  });

  it("asks to debug when the debug found blocking findings", () => {
    const d = dir();
    writeFileSync(join(d, "CUBICORE_PLAN.json"), "{}");
    const run = startRun(plan(), d);
    writeFileSync(join(d, ".cubicore", "runs.json"), JSON.stringify([{ ...run, state: "done" }]));
    writeFileSync(join(d, "CUBICORE_DEBUG.md"), "Cycle 1 of 3. 2 blocking, 1 advisory.\n");
    expect(blockingFindings(d)).toBe(2);
    expect(nextStep(d)).toBe("debug");
  });

  it("asks to deploy once everything passes", () => {
    const d = dir();
    writeFileSync(join(d, "CUBICORE_PLAN.json"), "{}");
    const run = startRun(plan(), d);
    writeFileSync(join(d, ".cubicore", "runs.json"), JSON.stringify([{ ...run, state: "done" }]));
    writeFileSync(join(d, "CUBICORE_DEBUG.md"), "Cycle 1 of 3. 0 blocking, 3 advisory.\n");
    expect(nextStep(d)).toBe("deploy");
  });

  it("offers to undo after a cancelled run", () => {
    const d = dir();
    writeFileSync(join(d, "CUBICORE_PLAN.json"), "{}");
    const run = startRun(plan(), d);
    writeFileSync(join(d, ".cubicore", "runs.json"), JSON.stringify([{ ...run, state: "cancelled" }]));
    expect(nextStep(d)).toBe("undo");
  });

  it("offers a choice, with the recommended one first", () => {
    const d = dir();
    writeFileSync(join(d, "CUBICORE_PLAN.json"), "{}");
    const options = nextOptions(d);
    expect(options.length).toBeGreaterThan(1);
    expect(options[0].step).toBe("execute");
    expect(options[0].recommended).toBe(true);
    // Every option is a real command, and the alternatives are named.
    expect(options.map((o) => o.step)).toContain("refine");
    expect(nextLine(d)).toContain("Or:");
  });

  it("offers only the one thing worth doing when there is nothing to choose", () => {
    // No plan: there is no meaningful alternative, so a list of nine would
    // be noise.
    expect(nextOptions(dir()).map((o) => o.step)).toEqual(["plan-demo"]);
  });

  it("names the command, not just the step", () => {
    const d = dir();
    expect(nextCommand(d)).toBe("/cubicore:plan-demo");
    expect(nextLine(d)).toContain("/cubicore:plan-demo");
    expect(nextLine(d)).toContain("there is no plan yet");
  });
});

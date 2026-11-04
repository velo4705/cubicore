import { describe, expect, it } from "bun:test";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promptFor } from "../src/mcp/server";
import { COMMAND, nextOptions } from "../src/mcp/next";
import { DEBUG_MD } from "../src/mcp/protocol";

/**
 * A command the founder is told to type has to exist.
 *
 * The Main agent writes the guidance that follows every step, and it
 * reaches for whatever the system has given it. When a plan carried a
 * `preview` block and the system had a `preview` tool, it told the founder to
 * run `/cubicore:preview` — a command that did not exist, because `preview` was
 * a tool and not a prompt. The founder would have typed it and got
 * nothing.
 *
 * Nothing in the test suite caught that, because the guidance is written
 * by a model and the test suite only ever checked the parts we wrote
 * ourselves. This test checks the seam: every command named in the
 * system's own guidance has to be a command we register.
 */

const COMMANDS = [
  "plan-demo",
  "plan-full",
  "execute",
  "refine",
  "debug",
  "undo",
  "estimate",
  "deploy",
  "preview",
  "status",
] as const;

describe("the command surface", () => {
  it("registers every command the guidance can name", () => {
    for (const name of COMMANDS) {
      const prompt = promptFor(name, {});
      expect(prompt).toBeDefined();
      expect(prompt.messages.length).toBeGreaterThan(0);
      expect(prompt.messages[0].content.text.length).toBeGreaterThan(0);
    }
  });

  it("gives every command a description, so a client can list them", () => {
    for (const name of COMMANDS) {
      expect(promptFor(name, {}).description.length).toBeGreaterThan(0);
    }
  });
});

describe("the guidance names real commands", () => {
  /**
   * `nextOptions` renders the "what to type next" line. Every command in
   * it must be one we register, because the founder copies it literally.
   */
  it("only ever suggests registered commands", () => {
    const registered = new Set<string>(COMMANDS);
    const dir = mkdtempSync(join(tmpdir(), "cubicore-surface-"));

    // An empty directory: nothing planned, nothing run.
    const empty = nextOptions(dir);
    expect(empty.length).toBeGreaterThan(0);

    for (const option of empty) {
      const name = option.step.replace(/^\/cubicore:/, "").trim();
      expect(registered.has(name)).toBe(true);
    }
  });

  it("keeps the next-step vocabulary inside the command surface", () => {
    // `NextStep` is the internal vocabulary the guidance is written in. If
    // it grows a value with no command behind it, the founder gets told to
    // type something that does not exist.
    const registered = new Set<string>(COMMANDS);
    for (const step of Object.keys(COMMAND)) {
      const command = COMMAND[step as keyof typeof COMMAND];
      if (command === "") continue; // "done" is the end, not a command
      const name = command.replace(/^\/cubicore:/, "").trim();
      expect(registered.has(name)).toBe(true);
    }
  });

  it("debug with no blocking findings suggests deploy, not execute", () => {
    const dir = mkdtempSync(join(tmpdir(), "cubicore-surface-"));
    writeFileSync(join(dir, "CUBICORE_PLAN.json"), JSON.stringify({ topology: "fan-out", contracts: [] }));
    writeFileSync(join(dir, DEBUG_MD), "Cycle 0 of 3. 0 blocking, 2 advisory.");
    mkdirSync(join(dir, ".cubicore"), { recursive: true });
    writeFileSync(
      join(dir, ".cubicore", "runs.json"),
      JSON.stringify([{ id: "run-1", startedAt: 1, finishedAt: 2, plan: {}, state: "done", progress: [], directory: dir }])
    );
    const options = nextOptions(dir);
    const recommended = options.find((o) => o.recommended);
    expect(recommended?.step).toBe("deploy");
  });
});

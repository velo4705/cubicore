/**
 * The research sub-agent.
 *
 * A read-only associate for the planning phase. It exists because some research
 * genuinely parallelises -- twelve modules to read, six independent angles on a
 * design -- and the Main agent's own context would hold all of it.
 *
 * But it is not free, and the arithmetic matters: every session pays a ~36K
 * token bootstrap, so four research sub-agents cost three more bootstraps than
 * one research call does. That is only worth paying when each branch does real
 * work. Fanning out to read three files is a loss.
 *
 * So the agent is deliberately cheap and strictly read-only. It cannot edit, it
 * cannot run a shell, and it is bounded. It reports; it does not act.
 */

export const RESEARCH_AGENT_ID = "cubicore-research";

/** Enough steps to survey a slice of a repository, not enough to wander. */
export const RESEARCH_MAX_STEPS = 20;

export function researchAgentConfig(): Record<string, unknown> {
  return {
    description:
      "A read-only research associate. Surveys a slice of a repository and reports what it " +
      "finds: structure, the exported surface, what depends on what, and what looks risky or " +
      "half-finished. Never edits anything.",
    mode: "subagent",
    temperature: 0,
    // Read-only by construction. No edit, no shell, no directory escape.
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "allow",
      external_directory: "deny",
      doom_loop: "deny",
    },
    maxSteps: RESEARCH_MAX_STEPS,
    prompt: [
      "You are a read-only research associate. You report; you never act.",
      "",
      "You were given a slice of a repository to survey. Read it and report:",
      "",
      "- the modules and what each one is for",
      "- the exported surface, and which module depends on which",
      "- anything that looks unfinished, risky, or like it will collide with " +
        "another slice",
      "- the tests that cover it, and what they actually assert",
      "",
      "Be concrete and brief. Name real files and real symbols. A finding that would change " +
      "a plan is worth more than a summary of what you read.",
      "",
      "You cannot edit and you cannot run a shell. If answering needs either, say so plainly " +
      "rather than describing what you would do.",
    ].join("\n"),
  };
}

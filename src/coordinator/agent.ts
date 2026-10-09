/**
 * The coordinator agent.
 *
 * The coordinator cannot be an ordinary opencode agent asked politely to emit
 * JSON. Measured, twice:
 *
 *   - with tools enabled it reads the planner prompt as a coding request,
 *     explores the repository with `bash` for 30–80 turns (~47k tokens) and
 *     returns prose
 *   - with `body.tools` all false it still emits tool parts and returns the
 *     prompt echoed back verbatim
 *
 * opencode 1.18.35 has no non-agentic completion endpoint, so the answer is a
 * *constrained agent* rather than a plain call. `maxSteps` is the lever that
 * matters: "maximum number of agentic iterations before forcing text-only
 * response". It is what stops the exploration loop, not the tool denial — the
 * tool denial only stops side effects, not the loop itself.
 *
 * This keeps the coordinator inside opencode, which is the whole point of
 * opencode-first: a named constrained agent is portable to the Claude Code port,
 * where a raw provider call would not be.
 */

export const PLANNER_AGENT_ID = "cubicore-planner";

/**
 * Enough steps to read the schema and answer, few enough that it cannot wander.
 * One was the first guess and is probably too tight for a prompt this long;
 * raise it if the coordinator returns prose, lower it if it starts exploring.
 */
export const PLANNER_MAX_STEPS = 3;

export interface PlannerAgentConfig {
  description: string;
  mode: "subagent";
  hidden?: boolean;
  model?: string;
  prompt: string;
  /** Empty map denies every tool. */
  tools: Record<string, boolean>;
  maxSteps: number;
  permission: {
    edit: "deny";
    bash: "deny";
    webfetch: "deny";
    external_directory: "deny";
  };
  /** Forces a text-only response rather than leaving the model mid-thought. */
  temperature: number;
}

/**
 * The agent config the plugin injects through its `config` hook.
 *
 * `tools: {}` is deliberate: opencode treats an empty tool map as "omit
 * everything", so no tool name has to be guessed or kept in sync.
 */
export function plannerAgentConfig(options: {
  prompt: string;
  model?: string;
  maxSteps?: number;
}): PlannerAgentConfig {
  return {
    description:
      "Emits a Cubicore plan as JSON. Emits JSON and nothing else. Never uses tools.",
    mode: "subagent",
    hidden: true,
    model: options.model,
    prompt: options.prompt,
    tools: {},
    maxSteps: options.maxSteps ?? PLANNER_MAX_STEPS,
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      external_directory: "deny",
    },
    // Low temperature: this is a formatting task, not a reasoning one. A hot
    // model wanders into prose and explanations.
    temperature: 0,
  };
}

/**
 * Folds the planner agent into an opencode config object.
 *
 * Returns a new object rather than mutating, because the `config` hook hands us
 * the user's own configuration and silently editing it in place would be rude
 * and hard to trace.
 */
export function withPlannerAgent<T extends { agent?: Record<string, unknown> }>(
  config: T,
  options: { prompt: string; model?: string; maxSteps?: number },
): T & { agent: Record<string, unknown> } {
  return {
    ...config,
    agent: {
      ...(config.agent ?? {}),
      [PLANNER_AGENT_ID]: plannerAgentConfig(options),
    },
  };
}

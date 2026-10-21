/**
 * Every agent Cubicore defines, in one place.
 *
 * The two agent definitions used to live in separate files, and four separate
 * places had to know their ids: the installer that writes them into the
 * host's config, the plugin's config hook that refreshes them, the dispatch
 * blueprint that names one, and the status check that looks one up. Adding a
 * third agent meant editing all four correctly, and nothing would have said so
 * if you forgot.
 *
 * So: one registry. Adding an agent is one entry. The installer writes every
 * entry. The config hook refreshes every entry. Nothing knows a sibling's
 * name, because nothing has to.
 *
 * The prefix is applied here rather than at each definition site, so a new
 * agent cannot accidentally land in the user's namespace and collide with
 * something they wrote.
 */

import { associateAgentConfig, ASSOCIATE_AGENT_ID } from "./inline";
import { researchAgentConfig, RESEARCH_AGENT_ID } from "./research-agent";

/** The namespace every Cubicore agent lives under. */
export const AGENT_PREFIX = "cubicore-";

export interface RegisteredAgent {
  /** The id as it appears in the host's agent list. */
  id: string;
  /** What it is for, in one line. */
  purpose: string;
  /** The host's agent configuration. */
  config: Record<string, unknown>;
  /**
   * Whether a human should see this in an @-mention list.
   *
   * Execution and research associates are dispatched by Cubicore, not chosen
   * by hand, so they are hidden. A future agent meant for the founder to pick
   * would set this false.
   */
  hidden: boolean;
}

function registered(
  id: string,
  purpose: string,
  config: Record<string, unknown>,
  hidden = true,
): RegisteredAgent {
  return { id, purpose, config, hidden };
}

export const CUBICORE_AGENTS: readonly RegisteredAgent[] = [
  registered(
    ASSOCIATE_AGENT_ID,
    "Executes one contract: a bounded write scope, a deliverable, and checks.",
    associateAgentConfig(),
  ),
  registered(
    RESEARCH_AGENT_ID,
    "Read-only associate for the planning phase. Surveys a slice and reports.",
    researchAgentConfig(),
  ),
];

/** The ids, for callers that need to name one without reaching into a file. */
export const CUBICORE_AGENT_IDS: readonly string[] = CUBICORE_AGENTS.map((a) => a.id);

/** The agent that executes contracts. */
export const EXECUTE_AGENT_ID = ASSOCIATE_AGENT_ID;

/** The agent that surveys a slice during planning. */
export const RESEARCH_AGENT_ID_EXPORT = RESEARCH_AGENT_ID;

export function agentById(id: string): RegisteredAgent | undefined {
  return CUBICORE_AGENTS.find((a) => a.id === id);
}

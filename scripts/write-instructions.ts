/** Regenerates cubicore-main-agent.md from the source of truth. */
import { MAIN_AGENT_INSTRUCTIONS, MAIN_AGENT_INSTRUCTIONS_PATH } from "../src/coordinator/main-agent";

await Bun.write(MAIN_AGENT_INSTRUCTIONS_PATH, MAIN_AGENT_INSTRUCTIONS);
console.log(`wrote ${MAIN_AGENT_INSTRUCTIONS_PATH}`);

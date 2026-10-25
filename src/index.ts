/**
 * Cubicore — opencode plugin entry point.
 *
 * Opencode loads a plugin module and calls its `server` to install hooks and
 * tools. Until this file existed, Cubicore could only be measured against what
 * it competes with — never against itself. This is what makes the `orchestrated`
 * arm of the benchmark runnable: opencode can load the plugin, expose the
 * `cubicore` tool, and the founder can drive a real plan → dispatch → gate
 * → aggregate run through the host.
 *
 * The orchestration itself lives in `src/adapters/opencode/plugin.ts`; this
 * file is only the surface opencode loads. Keeping them separate means the
 * benchmark can import the plugin directly (in-process) while opencode loads
 * it through the normal plugin path, and both exercise the same code.
 */

import { CubicorePlugin } from "./adapters/opencode/plugin";

export { CubicorePlugin };

/** Opencode calls this to install the plugin. */
export const server = CubicorePlugin;

export default CubicorePlugin;

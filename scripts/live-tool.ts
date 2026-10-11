import { createOpencodeClient } from "@opencode-ai/sdk";

/**
 * End-to-end check of the real plugin path: a plan goes into the `cubicore`
 * tool, and the plugin's own event hook resolves the workers.
 *
 * This differs from testing `dispatch` directly: the event hook is what turns
 * `session.idle` into a resolved worker result, so a harness that calls
 * dispatch by hand hangs forever no matter how correct the product is.
 */

const PORT = process.env.PORT ?? "4631";
const directory = "/home/nix/Projects/cubicore/.live/benchrepo";

const client = createOpencodeClient({
  baseUrl: `http://127.0.0.1:${PORT}`,
  directory,
  headers: {
    Authorization: `Basic ${btoa(
      process.env.OPENCODE_SERVER_USERNAME + ":" + process.env.OPENCODE_SERVER_PASSWORD,
    )}`,
  },
});

const plugin = (await import("../src/index")).default;
const hooks = typeof plugin === "function" ? await plugin({ client, directory, worktree: directory }) : plugin;

console.log("hooks:", Object.keys(hooks).join(", "));
if (typeof hooks.event === "function") {
  await hooks.event({ event: { type: "server.connected" } } as never);
}

const contract = (id: string, src: string, out: string) => ({
  id,
  objective: `Write documentation for the exported helper in ${src}`,
  reads: [src],
  writes: [out],
  forbidden: [],
  deliverable: "report",
  schema: { type: "object", properties: { files: { type: "array" } } },
  doneWhen: `${out} exists and mentions f0`,
  checks: [
    {
      id: `${id}-doc`,
      kind: "intent",
      command: `test -f ${out} && grep -q 'f0' ${out}`,
      expectation: `${out} exists and mentions f0`,
      gating: "blocking",
      convergent: true,
    },
  ],
  budget: { tokens: 30_000, toolCalls: 60, wallMs: 240_000 },
});

const plan = {
  topology: "fan-out",
  contracts: [
    contract("doc-a", "src/module-1.ts", "src/module-1.md"),
    contract("doc-b", "src/module-2.ts", "src/module-2.md"),
  ],
  graphBudget: { nodes: 2, edges: 1, tokens: 60_000, wallMs: 480_000 },
};

// Keep the event pump running for the duration of the dispatch. The SDK's
// `event.subscribe` returns a Response rather than an async iterable in this
// version, so read the SSE stream directly and parse the event payloads.
const auth = `Basic ${btoa(
  process.env.OPENCODE_SERVER_USERNAME + ":" + process.env.OPENCODE_SERVER_PASSWORD,
)}`;
const pump = (async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/event?directory=${encodeURIComponent(directory)}`, {
    headers: { Authorization: auth, Accept: "text/event-stream" },
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          await hooks.event?.({ event: JSON.parse(line.slice(5).trim()) } as never);
        } catch {}
      }
    }
  }
})();

const tool = (hooks.tool as Record<string, { execute: (a: never, c: never) => Promise<string> }>).cubicore;
console.log("\n--- calling cubicore ---");
const started = Date.now();
const result = await tool.execute({ plan: JSON.stringify(plan), workerModel: "opencode/space-bunny-free" } as never, {
  directory,
  agent: "build",
} as never);

console.log(`\n=== cubicore returned after ${Date.now() - started}ms ===`);
console.log(result);
pump.catch(() => {});
process.exit(0);
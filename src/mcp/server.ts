import { parsePlan, MalformedPlan } from "../coordinator/parse";
import { validatePlan } from "../validate/plan";
import { checkTopology } from "../coordinator/topology";
import { dispatch } from "../dispatch";
import { aggregate } from "../aggregate";
import { RunRecorder } from "../telemetry/report";
import { PhaseTimer } from "../telemetry/timing";
import { PLAN_SCHEMA_JSON } from "../contracts/schema";
import { ProgressSink } from "./progress";
import { runtimeFromEnv, workerSessions, type Runtime } from "./runtime";
import type { Plan } from "../contracts/types";

/**
 * Cubicore's MCP front-end.
 *
 * Two tools, split on purpose. `cubicore_plan` costs nothing and returns the
 * decomposition as data, so the founder can read it before anything is spent.
 * `cubicore_execute` takes that same plan and dispatches it. Splitting them is
 * what makes the Main agent's planning reviewable rather than something you
 * infer from a wall of text after the tokens are gone.
 *
 * MCP rather than plugin because clients surface MCP prompts as slash commands,
 * and because every other agent host speaks it. The plugin keeps only
 * `chat.params`, which is the one hook MCP cannot provide: an output cap is
 * attached to a chat message, and an MCP tool call has no message to attach one
 * to.
 */

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const PLAN_SCHEMA = PLAN_SCHEMA_JSON;

async function pumpEvents(
  runtime: Runtime,
  workers: { onEvent(event: unknown): void },
  signal: AbortSignal,
): Promise<void> {
  const auth = `Basic ${btoa(
    `${process.env.OPENCODE_SERVER_USERNAME ?? ""}:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`,
  )}`;
  const port = process.env.OPENCODE_PORT ?? process.env.OPENCODE_SERVER_PORT ?? "4096";

  while (!signal.aborted) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/event?directory=${encodeURIComponent(runtime.directory)}`,
        { headers: { Authorization: auth, Accept: "text/event-stream" }, signal },
      );
      const body = response.body;
      if (!body) return;

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) return;
        buffer += decoder.decode(value, { stream: true });

        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              workers.onEvent(JSON.parse(line.slice(5).trim()));
            } catch {
              // A malformed frame is not worth failing the run over.
            }
          }
        }
      }
    } catch {
      if (signal.aborted) return;
      await Bun.sleep(2000);
    }
  }
}

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: body }], isError };
}

/** Validate without dispatching. Free, and the reason the split exists. */
async function plan(raw: string): Promise<ToolResult> {
  let parsed: Plan;
  try {
    parsed = parsePlan(raw) as Plan;
  } catch (error) {
    const problems = error instanceof MalformedPlan ? error.problems : [String(error)];
    return text(
      ["Malformed plan:", ...problems.map((p) => `- ${p}`), "", `Schema: ${PLAN_SCHEMA}`].join("\n"),
      true,
    );
  }

  if (parsed.topology === "refuse") {
    return text("This plan refuses to split. Nothing to dispatch, and that is a valid answer.");
  }

  const validation = validatePlan(parsed, []);
  const topology = checkTopology(parsed);

  const problems: string[] = validation.findings.map((f) => `- [${f.code}] ${f.message}`);

  if (topology.cycles.length > 0) {
    problems.push(
      `- [dependency-cycle] ${topology.cycles.map((c) => c.join(" -> ")).join("; ")}. ` +
        "Not a divide-and-conquer task — return `refuse`.",
    );
  } else if (!topology.ok) {
    problems.push(
      `- [mis-declared-topology] declared \`${topology.declared}\` but the plan implies \`${topology.implied}\``,
    );
  }

  const summary = [
    `topology: ${parsed.topology}`,
    `associates: ${parsed.contracts.length} (budget allows ${parsed.graphBudget.nodes})`,
    ...parsed.contracts.map(
      (c) => `- ${c.id}: ${c.deliverable} -> ${c.writes.join(", ") || "(no writes)"}`,
    ),
  ];

  if (problems.length > 0) {
    return text(
      [`Plan rejected before dispatch — nothing was spent.`, "", ...problems, "", "--- plan ---", ...summary].join(
        "\n",
      ),
      true,
    );
  }

  return text([...summary, "", "Call cubicore_execute with this plan to dispatch it."].join("\n"));
}

async function execute(raw: string): Promise<ToolResult> {
  const runtime = runtimeFromEnv();

  let parsed: Plan;
  try {
    parsed = parsePlan(raw) as Plan;
  } catch (error) {
    const problems = error instanceof MalformedPlan ? error.problems : [String(error)];
    return text(`Malformed plan:\n${problems.map((p) => `- ${p}`).join("\n")}`, true);
  }

  if (parsed.topology === "refuse") {
    return text("This plan refuses to split. Nothing dispatched.");
  }

  const validation = validatePlan(parsed, []);
  const topology = checkTopology(parsed);
  if (!validation.ok || topology.cycles.length > 0 || !topology.ok) {
    return text(
      "Plan rejected before dispatch — nothing was spent. Run cubicore_plan to see why.",
      true,
    );
  }

  const progress = new ProgressSink(parsed.contracts);
  process.stderr.write(
    `[cubicore ${parsed.contracts.length} associates, topology ${parsed.topology}]\n`,
  );

  const workers = workerSessions(runtime, progress);
  // The event connection never closes on its own, so it is aborted once
  // dispatch returns. Without this the process lives forever and the client
  // waits on a response it already has.
  const controller = new AbortController();
  const pump = pumpEvents(runtime, workers, controller.signal);
  pump.catch(() => {});

  const timer = new PhaseTimer();
  const recorder = new RunRecorder(parsed.topology, timer);

  const outcome = await dispatch(
    parsed,
    workers.asRunner(),
    { run: async (command: string) => {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd: runtime.directory,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode: await proc.exited, output: `${stdout}\n${stderr}`.trim() };
    } },
    {
      repo: {
        anchors: () => new Map(),
        testFiles: () => [],
      },
    },
  );

  const usage = outcome.accepted
    .concat(outcome.failed.map((f) => f.result))
    .reduce(
      (sum, r) => ({
        input: sum.input + r.usage.input,
        output: sum.output + r.usage.output,
        cacheRead: sum.cacheRead + r.usage.cacheRead,
        cacheWrite: sum.cacheWrite + r.usage.cacheWrite,
        reasoning: sum.reasoning + r.usage.reasoning,
        cost: sum.cost + r.usage.cost,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
    );
  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.reasoning;

  const aggregated = aggregate(
    [...outcome.accepted, ...outcome.failed.map((f) => f.result)],
    outcome.unresolved,
    recorder.finish(usage),
  );

  controller.abort();

  return text(
    [
      `${parsed.topology} · ${outcome.accepted.length} passed, ${outcome.failed.length} flagged, ` +
        `${outcome.deferred.length} deferred`,
      `tokens: ${totalTokens} (in ${usage.input}, out ${usage.output}, cache ${usage.cacheRead})`,
      "",
      ...aggregated.artifacts.map(
        (a) => `- ${a.contractId}: ${a.status}${a.unresolved.length ? ` — ${a.unresolved.join("; ")}` : ""}`,
      ),
    ].join("\n"),
  );
}

export const TOOLS = [
  {
    name: "cubicore_plan",
    description:
      "Validate a Cubicore plan and return the decomposition without dispatching. " +
      "Costs nothing. Call this before cubicore_execute so the founder can read the split.",
    inputSchema: {
      type: "object",
      properties: { plan: { type: "string", description: "Plan JSON matching the Cubicore plan schema." } },
      required: ["plan"],
    },
    handler: async (args: { plan: string }) => plan(args.plan),
  },
  {
    name: "cubicore_execute",
    description:
      "Dispatch a validated Cubicore plan across parallel associates, gate each result, " +
      "and aggregate the artifacts. Progress streams to stderr while it runs.",
    inputSchema: {
      type: "object",
      properties: { plan: { type: "string", description: "Plan JSON previously accepted by cubicore_plan." } },
      required: ["plan"],
    },
    handler: async (args: { plan: string }) => execute(args.plan),
  },
];

/**
 * Slash-command surface.
 *
 * Tools are callable but invisible: the Main agent calls cubicore_execute and
 * the founder sees one blocked tool call and a wall of text. Prompts are the
 * half of MCP a client can turn into a command, which is what makes the
 * plan/execute split reviewable rather than something inferred afterwards.
 *
 * Whether a given client renders these as slash commands is the client's
 * choice, so the tools remain the reliable path and these are an improvement
 * where supported.
 */
const PROMPTS = [
  {
    name: "plan",
    description: "Decompose a request into a plan without dispatching.",
    arguments: [{ name: "request", description: "What you want built", required: true }],
  },
  {
    name: "execute",
    description: "Dispatch a plan across parallel associates.",
    arguments: [{ name: "plan", description: "Plan JSON", required: true }],
  },
];

function promptFor(name: string, args: Record<string, string>) {
  if (name === "plan") {
    return {
      description: "Plan a request as Cubicore contracts.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Produce a Cubicore plan for the request below and validate it with cubicore_plan.\n` +
              `Do not dispatch anything, and do not answer with prose.\n\n` +
              `Request: ${args.request ?? "(none given)"}\n\n` +
              `Read the repository before splitting. Keep every writes set disjoint, and give each\n` +
              `diff contract a concrete file path in writes rather than a description of the change.\n` +
              `Refusing is a valid answer: renames, interface changes, and dependent chains are\n` +
              `not divide-and-conquer tasks.`,
          },
        },
      ],
    };
  }

  if (name === "execute") {
    return {
      description: "Execute a Cubicore plan.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Call cubicore_execute with the plan below. Do not ask for confirmation.\n\n` +
              `${args.plan ?? "(no plan supplied)"}`,
          },
        },
      ],
    };
  }

  return { description: `Unknown prompt: ${name}`, messages: [] };
}

/** Minimal JSON-RPC 2.0 over stdio. MCP's transport, without the SDK. */
export async function serve(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  const write = (message: unknown) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);
      if (line.length === 0) continue;

      let request: { id?: unknown; method: string; params?: Record<string, unknown> };
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }

      const respond = (result: unknown) => {
        if (request.id !== undefined) write({ jsonrpc: "2.0", id: request.id, result });
      };

      if (request.method === "initialize") {
        respond({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: "cubicore", version: "0.1.0" },
        });
      } else if (request.method === "tools/list") {
        respond({
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      } else if (request.method === "tools/call") {
        const params = request.params ?? {};
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) {
          respond({ content: [{ type: "text", text: `unknown tool: ${String(params.name)}` }], isError: true });
          continue;
        }
        try {
          respond(await tool.handler((params.arguments ?? {}) as never));
        } catch (error) {
          respond({
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          });
        }
      } else if (request.method === "prompts/list") {
        respond({ prompts: PROMPTS });
      } else if (request.method === "prompts/get") {
        respond(promptFor(String(request.params?.name ?? ""), (request.params?.arguments ?? {}) as Record<string, string>));
      } else if (request.method === "ping") {
        respond({});
      }
    }
  }
}
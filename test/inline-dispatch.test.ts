import { afterEach, describe, expect, it } from "bun:test";

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentAvailable } from "../src/mcp/install";
import { TOOLS, promptFor } from "../src/mcp/server";

const PLAN = {
  topology: "fan-out",
  contracts: [
    {
      id: "c1",
      objective: "Create src/a.ts",
      reads: [],
      writes: ["src/a.ts"],
      forbidden: [],
      deliverable: "diff",
      schema: { type: "object" },
      doneWhen: "the file exists",
      checks: [
        {
          id: "c1-check",
          kind: "baseline",
          command: "true",
          expectation: "exit code 0",
          gating: "blocking",
          convergent: true,
        },
      ],
      budget: { tokens: 1000, toolCalls: 10, wallMs: 1000 },
    },
  ],
  graphBudget: { nodes: 1, edges: 0, tokens: 1000, wallMs: 1000 },
};

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.OPENCODE_SERVER_USERNAME = originalEnv.OPENCODE_SERVER_USERNAME;
  process.env.OPENCODE_SERVER_PASSWORD = originalEnv.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_PORT = originalEnv.OPENCODE_PORT;
});

describe("inline sub-task dispatch is available when the host supports it", () => {
  it("registers the dispatch_blueprint tool so the agent can create briefs", () => {
    expect(TOOLS.some((tool) => tool.name === "dispatch_blueprint")).toBe(true);
  });

  it("tells the execute prompt to use inline associates, not work alone", () => {
    const prompt = promptFor("execute", {}).messages?.[0]?.content.text ?? "";
    expect(prompt).toContain("dispatch_blueprint");
    expect(prompt).toContain("cubicore-associate");
    expect(prompt).toContain("parallel");
  });

  it("reports a 407 browser proxy instead of treating it as an absent agent", async () => {
    globalThis.fetch = (async () =>
      new Response("proxy denied", {
        status: 407,
        headers: { "Proxy-Authenticate": 'Basic realm="OpenCode Browser Proxy"' },
      })) as typeof fetch;

    const result = await agentAvailable("http://127.0.0.1:12345", "/tmp");
    expect(result.checked).toBe(false);
    expect(result.reason).toContain("407");
    expect(result.reason).toContain("OpenCode Browser Proxy");
  });

  it("reports HTML from /agent instead of attempting to parse it as JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("<!doctype html><title>OpenCode</title>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch;

    const result = await agentAvailable("http://127.0.0.1:12345", "/tmp");
    expect(result.checked).toBe(false);
    expect(result.reason).toContain("non-JSON");
  });

  it("still writes briefs and tells the agent to use host sub-agents despite an unverified list", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cubicore-inline-"));
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "CUBICORE_PLAN.json"), JSON.stringify(PLAN));

    process.env.OPENCODE_SERVER_USERNAME = "opencode";
    process.env.OPENCODE_SERVER_PASSWORD = "test-password";
    process.env.OPENCODE_PORT = "12345";

    globalThis.fetch = (async () =>
      new Response("<!doctype html><title>OpenCode</title>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch;

    const tool = TOOLS.find((candidate) => candidate.name === "dispatch_blueprint");
    expect(tool).toBeDefined();
    const handler = tool?.handler as unknown as (
      args: { directory?: string; projectKind?: string },
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

    const result = await handler({ directory, projectKind: "web app" });
    const output = result.content.map((part) => part.text).join("\n");
    const files = readdirSync(join(directory, "CUBICORE_ASSOCIATES")).sort();

    expect(files.length).toBeGreaterThanOrEqual(2); // one brief plus index
    expect(output).toContain("could not be verified");
    expect(output).toContain("task/sub-agent");
    expect(output).toContain("in parallel");
    expect(output).toContain("cubicore-associate");
  });
});

/**
 * Run one benchmark arm by hand and report its cost.
 *
 * The arms are three ways of doing the same work:
 *
 *   single        one agent documents every module in one session
 *   naive         twelve independent agents, one per module, no coordination
 *   orchestrated  Cubicore's plan: twelve contracts with disjoint write
 *                 scopes, gated and budgeted, dispatched as parallel
 *                 associates
 *
 * The comparison is tokens and wall time for the same twelve documents.
 * Every arm writes into the same tree, so the fixture is rebuilt first.
 *
 * Usage: bun run bench/arm.ts <single|naive|orchestrated> [--concurrency N]
 */
import { readFileSync } from "node:fs";

import { SqliteTokenSource } from "../src/telemetry/adapters/session-db";
import { writeFixture } from "./fixture";
import { CORPUS } from "../src/bench/corpus";
import { DEFAULT_MODEL } from "../src/mcp/model";

const arm = process.argv[2] ?? "single";
const concurrency = Number(process.argv[process.argv.indexOf("--concurrency") + 1] ?? 3);
const MODEL = process.env.MODEL ?? DEFAULT_MODEL;
const DIR = "/tmp/opencode/benchrepo";
const PORT = process.env.OPENCODE_PORT ?? "39417";

const task = CORPUS.find((t) => t.plan)!;
const names = (task.plan as { contracts: { id: string }[] }).contracts.map((c) => c.id.replace(/^doc-/, ""));

function sessionsSince(since: number): string[] {
  return new SqliteTokenSource().sessionsSince(DIR, since);
}

function usageOf(ids: string[]) {
  const db = new SqliteTokenSource();
  let input = 0, output = 0, cacheRead = 0, reasoning = 0;
  for (const id of ids) {
    const u = db.read(id);
    input += u.input;
    output += u.output;
    cacheRead += u.cacheRead;
    reasoning += u.reasoning;
  }
  return { input, output, cacheRead, reasoning, total: input + output + cacheRead + reasoning };
}

const prompt = `Document every exported module in src/. One document per module, in docs/.`;

async function runCli(p: string): Promise<void> {
  const proc = Bun.spawn(["opencode", "run", "--model", MODEL, p], {
    cwd: DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

async function main() {
  writeFixture(DIR);
  const since = Date.now() - 2000;
  const t0 = Date.now();

  if (arm === "single") {
    await runCli(prompt);
  } else if (arm === "naive") {
    // One independent agent per module, no coordination between them.
    let active = 0;
    const queue: Array<() => void> = [];
    const pump = async (fn: () => Promise<void>) => {
      if (active >= concurrency) await new Promise<void>((r) => queue.push(r));
      active++;
      try {
        await fn();
      } finally {
        active--;
        queue.shift()?.();
      }
    };
    await Promise.all(names.map((n) => pump(() => runCli(
      `Write docs/${n}.md documenting the exported module in src/${n}.ts. Name the exported function and describe what it returns. Write nothing else.`,
    ))));
  } else if (arm === "orchestrated") {
    const { OrchestratedRunner, pumpEvents } = await import("./cubicore");
    const { createOpencodeClient } = await import("@opencode-ai/sdk");
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${PORT}`,
      directory: DIR,
      headers: {
        Authorization: `Basic ${btoa(
          `${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`,
        )}`,
      },
    });
    const runner = new OrchestratedRunner({
      client: client as never,
      directory: DIR,
      models: { strong: MODEL, cheap: MODEL },
    });
    const stop = await pumpEvents(client as never, runner, DIR, `http://127.0.0.1:${PORT}`);
    await runner.run(task);
    stop();
  } else {
    console.error(`unknown arm: ${arm}`);
    process.exit(1);
  }

  const wall = Date.now() - t0;
  const ids = sessionsSince(since);
  const usage = usageOf(ids);
  console.log(`\n=== ${arm} ===`);
  console.log(`wall: ${(wall / 1000).toFixed(1)}s   sessions: ${ids.length}`);
  console.log(`in ${usage.input}  out ${usage.output}  cache ${usage.cacheRead}  reasoning ${usage.reasoning}`);
  console.log(`total tokens: ${usage.total}`);
}

await main();

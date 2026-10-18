import type { ArmName, TaskSpec, Trial } from "../src/bench/types";
import { CORPUS, promptFor } from "../src/bench/corpus";
import { FIXTURE_DIR, writeFixture } from "./fixture";
import { CliRunner } from "../src/bench/cli";
import { SqliteTokenSource } from "../src/bench/tokens";
import { addUsage, EMPTY_USAGE, totalTokens, type TokenUsage } from "../src/telemetry/types";
import { armReport, summariseClaim } from "../src/bench/aggregate";
import { OrchestratedRunner, pumpEvents } from "./cubicore";
import { createOpencodeClient } from "@opencode-ai/sdk";

/**
 * Benchmark entry point.
 *
 * Runs the arms this machine can actually run. The `orchestrated` arm needs the
 * opencode plugin entry point, which does not exist yet, so it is reported as
 * skipped rather than approximated with something that is not Cubicore.
 *
 * Usage: bun run bench [-- --reps N] [-- --model opencode/space-bunny-free]
 */

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const REPS = Number(flag("reps", "2"));
const MODEL = flag("model", "opencode/space-bunny-free");
const CWD = flag("cwd", FIXTURE_DIR);
/**
 * Where the opencode server is listening.
 *
 * opencode binds an ephemeral port, so there is nothing to default to -- the
 * previous 4599 was a guess that cost a full benchmark run to discover wrong.
 * Discovery matches a listener by owning process, because `ss -ltn` alone puts
 * CUPS first and would have returned the print spooler. An explicit --server
 * still wins.
 */
function discoverServer(): string {
  for (const cmd of [
    "ss -ltnp 2>/dev/null | grep -i opencode",
    "ss -ltnp 2>/dev/null | grep -i 'ai.opencode'",
    "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i opencode",
  ]) {
    try {
      const { stdout, exitCode } = Bun.spawnSync(["sh", "-c", cmd]);
      if (exitCode !== 0) continue;
      const match = /127\.0\.0\.1:(\d+)/.exec(new TextDecoder().decode(stdout));
      if (match) return `http://127.0.0.1:${match[1]}`;
    } catch {
      // try the next strategy
    }
  }
  return "http://127.0.0.1:4096";
}

const SERVER = flag("server", discoverServer());

/**
 * The SDK client needs a baseUrl and, when the server was started with
 * OPENCODE_SERVER_PASSWORD, basic auth. Without both, `session.create` fails
 * with a 401 that surfaces as an empty response rather than an error — which
 * looks exactly like a measurement failure.
 */
function makeClient() {
  const headers: Record<string, string> = {};
  const user = process.env.OPENCODE_SERVER_USERNAME;
  const pass = process.env.OPENCODE_SERVER_PASSWORD;
  if (user && pass) headers.Authorization = `Basic ${btoa(user + ":" + pass)}`;
  return createOpencodeClient({ baseUrl: SERVER, directory: CWD, headers });
}

async function single(task: TaskSpec): Promise<Trial> {
  const runner = new CliRunner({ model: MODEL, cwd: CWD });
  const tokens = new SqliteTokenSource();
  try {
    const { sessionId, durationMs } = await runner.run({
      taskId: task.id,
      arm: "single",
      prompt: task.prompt.replace(/\{N\}/g, "1-4"),
    });
    return { taskId: task.id, arm: "single", durationMs, usage: tokens.read(sessionId) };
  } catch (error) {
    return failed(task.id, "single", error);
  }
}

/**
 * The control: N independent agents, no coordination, no shared context, each
 * paying full session price.
 *
 * Run **concurrently**, deliberately. Running them sequentially would make the
 * baseline look bad for reasons that have nothing to do with orchestration, and
 * the claim being tested is whether Cubicore beats what you would otherwise
 * have written — which is parallel naive fan-out.
 */
async function naiveFanOut(task: TaskSpec): Promise<Trial> {
  const tokens = new SqliteTokenSource();
  const startedAt = Date.now();

  const results = await Promise.all(
    Array.from({ length: task.expectedWorkers }, async (_, index) => {
      const runner = new CliRunner({ model: MODEL, cwd: CWD });
      try {
        return await runner.run({
          taskId: task.id,
          arm: "naive-fanout",
          prompt: promptFor(task, index),
        });
      } catch {
        return null;
      }
    }),
  );

  let usage: TokenUsage = EMPTY_USAGE;
  let succeeded = 0;
  for (const result of results) {
    if (!result) continue;
    succeeded++;
    usage = addUsage(usage, tokens.read(result.sessionId));
  }

  if (succeeded === 0) {
    return {
      taskId: task.id,
      arm: "naive-fanout",
      durationMs: 0,
      usage: EMPTY_USAGE,
      timedOut: true,
    };
  }

  return {
    taskId: task.id,
    arm: "naive-fanout",
    durationMs: Date.now() - startedAt,
    usage,
  };
}

/**
 * The arm under test. Drives Cubicore's own plan -> dispatch -> gate path
 * against a live client, with the event stream pumped in so observers see
 * `session.idle` exactly as they would inside the plugin.
 */
async function orchestrated(task: TaskSpec): Promise<Trial> {
  const client = makeClient();
  const runner = new OrchestratedRunner({
    client: client as never,
    directory: CWD,
    models: { strong: MODEL, cheap: MODEL },
  });

  const stop = await pumpEvents(client as never, runner, CWD, SERVER);
  try {
    return await runner.run(task);
  } catch (error) {
    console.error(`  orchestrated error: ${error instanceof Error ? error.message : String(error)}`);
    return failed(task.id, "orchestrated", error);
  } finally {
    stop();
  }
}

function failed(taskId: string, arm: ArmName, error: unknown): Trial {
  console.error(`  ${arm} failed: ${error instanceof Error ? error.message : String(error)}`);
  return { taskId, arm, durationMs: 0, usage: EMPTY_USAGE, timedOut: true };
}

async function main(): Promise<void> {
  // The fixture must match the corpus plan exactly -- twelve modules, same
// names -- or the associates read files that do not exist and the arm measures
// a plan that could never have succeeded.
writeFixture(CWD);

console.log(`reps=${REPS} model=${MODEL} cwd=${CWD} server=${SERVER}`);
  const trials: Trial[] = [];

  for (const task of CORPUS) {
    for (let rep = 0; rep < REPS; rep++) {
      console.log(`\n${task.id} rep ${rep + 1}/${REPS}`);
      const s = await single(task);
      console.log(`  single       ${s.durationMs}ms  in=${s.usage.input} cache=${s.usage.cacheRead} out=${s.usage.output}`);
      trials.push(s);

      const n = await naiveFanOut(task);
      console.log(`  naive x${task.expectedWorkers}    ${n.durationMs}ms  in=${n.usage.input} cache=${n.usage.cacheRead} out=${n.usage.output}`);
      trials.push(n);

      const o = await orchestrated(task);
      console.log(`  orchestrated    ${o.durationMs}ms  in=${o.usage.input} cache=${o.usage.cacheRead} out=${o.usage.output}${o.timedOut ? "  [refused/fallback]" : ""}`);
      trials.push(o);
    }
  }

  report(trials);
}

function report(trials: Trial[]): void {
  const baseline = trials.filter((t) => t.arm === "single");
  const naive = trials.filter((t) => t.arm === "naive-fanout");
  const orch = trials.filter((t) => t.arm === "orchestrated");

  console.log("\n" + "=".repeat(66));
  console.log("SINGLE        ", stats(baseline));
  console.log("NAIVE FAN-OUT ", stats(naive));
  console.log("ORCHESTRATED  ", stats(orch));
  console.log("=".repeat(66));

  const claim = summariseClaim(
    naive.flatMap((t) => {
      const matches = baseline.filter((b) => b.taskId === t.taskId);
      return matches.map((b) => ({
        taskId: t.taskId,
        baselineMs: b.durationMs,
        candidateMs: t.durationMs,
        ratio: t.durationMs / b.durationMs,
      }));
    }),
  );

  console.log(`\nnaive vs single speed ratio (median): ${claim.speedup.toFixed(2)}x`);
  console.log(`stable: ${claim.stable} (spread ${claim.speedupSpread.toFixed(2)}, range ${claim.speedupRange.map((r) => r.toFixed(2)).join("..")})`);
  const base = summariseClaim(
    orch.flatMap((t) =>
      baseline.filter((b) => b.taskId === t.taskId).map((b) => ({
        taskId: t.taskId,
        baselineMs: b.durationMs,
        candidateMs: t.durationMs,
        ratio: t.durationMs / b.durationMs,
      })),
    ),
  );
  const vsNaive = summariseClaim(
    orch.flatMap((t) =>
      naive.filter((n) => n.taskId === t.taskId).map((n) => ({
        taskId: t.taskId,
        baselineMs: n.durationMs,
        candidateMs: t.durationMs,
        ratio: t.durationMs / n.durationMs,
      })),
    ),
  );

  console.log(`\norchestrated vs single : ${base.speedup.toFixed(2)}x wall  (stable: ${base.stable})`);
  console.log(`orchestrated vs naive  : ${vsNaive.speedup.toFixed(2)}x wall  (stable: ${vsNaive.stable})`);
  console.log(`Y (token ratio vs naive): ${tokenRatio(orch, naive).toFixed(2)}x`);
}

function tokenRatio(candidate: readonly Trial[], baseline: readonly Trial[]): number {
  const c = candidate.reduce((a, t) => a + totalTokens(t.usage), 0);
  const b = baseline.reduce((a, t) => a + totalTokens(t.usage), 0);
  return b > 0 ? c / b : 0;
}

function stats(trials: readonly Trial[]): string {
  if (trials.length === 0) return "no trials";
  const sum = trials.reduce(
    (acc, t) => ({
      ms: acc.ms + t.durationMs,
      tokens: acc.tokens + totalTokens(t.usage),
    }),
    { ms: 0, tokens: 0 },
  );
  return `n=${trials.length}  mean ${Math.round(sum.ms / trials.length)}ms  mean ${Math.round(sum.tokens / trials.length)} tokens`;
}

await main();
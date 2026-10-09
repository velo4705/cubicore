import type { TokenUsage } from "../telemetry/types";
import type { ArmName, Trial } from "./types";

/**
 * Running a task, provider-agnostically.
 *
 * The benchmark drives the agent from the *outside* rather than from inside the
 * plugin. That is deliberate: the plugin grading its own runs is the same
 * circularity that makes an agent's self-reported completion untrustworthy, and
 * it would invalidate the only number this project has to sell.
 */

/**
 * Where token counts come from once a run has finished.
 *
 * Sync is allowed because a local SQLite read genuinely is synchronous — the
 * opencode session database has no network hop. A remote source would return a
 * promise. Callers await either.
 */
export interface TokenSource {
  read(sessionId: string): TokenUsage | Promise<TokenUsage>;
}

export interface RunRequest {
  taskId: string;
  arm: ArmName;
  prompt: string;
  /** Naive fan-out runs one agent per chunk with no shared context. */
  chunks?: string[];
  timeoutMs?: number;
}

export interface Runner {
  run(request: RunRequest): Promise<{ sessionId: string; durationMs: number }>;
}

export interface BenchOptions {
  repetitions: number;
  tokens: TokenSource;
  run: Runner;
  onTrial?: (trial: Trial) => void;
}

/** Hard cap per trial. A hung agent must not stall the whole benchmark. */
export const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Runs every arm for one task, `repetitions` times each.
 *
 * Arms are interleaved rather than run in blocks — single, then naive, then
 * orchestrated. Blocking lets a slow patch or a warm-up bias land on one arm
 * only, which is exactly the kind of confound a 2x claim cannot survive.
 */
export async function runTask(
  task: { id: string; prompt: string; expectedWorkers: number },
  options: BenchOptions,
): Promise<Trial[]> {
  const trials: Trial[] = [];
  const arms: ArmName[] = ["single", "naive-fanout", "orchestrated"];

  for (let repetition = 0; repetition < options.repetitions; repetition++) {
    for (const arm of arms) {
      const request: RunRequest = {
        taskId: task.id,
        arm,
        prompt: task.prompt,
      };

      if (arm === "naive-fanout") {
        request.chunks = splitForFanOut(task, task.expectedWorkers);
      }

      let record: { sessionId: string; durationMs: number } | null = null;
      let timedOut = false;

      try {
        record = await withTimeout(
          options.run.run({ ...request, timeoutMs: DEFAULT_TIMEOUT_MS }),
          request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      } catch (error) {
        if (!(error instanceof BenchTimeout)) throw error;
        timedOut = true;
      }

      const usage = record ? await options.tokens.read(record.sessionId) : emptyUsage();

      const trial: Trial = {
        taskId: task.id,
        arm,
        durationMs: record?.durationMs ?? 0,
        usage,
        timedOut,
      };

      trials.push(trial);
      options.onTrial?.(trial);
    }
  }

  return trials;
}

/** Exported so tests can exercise the timeout path without waiting on a real one. */
export class BenchTimeout extends Error {
  constructor() {
    super("bench trial exceeded its timeout");
    this.name = "BenchTimeout";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BenchTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/**
 * The naive control's chunks.
 *
 * Each chunk gets the full prompt plus its slice, because that is what "no
 * shared context" means operationally — every worker pays full context price.
 * This is the cost the contract layer exists to beat, so it must be measured
 * rather than assumed.
 */
export function splitForFanOut(
  task: { prompt: string },
  workers: number,
): string[] {
  const width = Math.max(1, workers);
  return Array.from({ length: width }, (_, index) =>
    `${task.prompt}\n\nYou are worker ${index + 1} of ${width}. Complete the whole task independently.`,
  );
}

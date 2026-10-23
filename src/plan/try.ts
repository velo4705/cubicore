/**
 * Running the result.
 *
 * Your org chart says the Main agent should "address how to make the project
 * work once the project is done". That step did not exist, and its absence
 * had a visible consequence: a completed, fully-passing toolkit that could
 * not be started. `listen()` was there, every check was green, and the founder
 * still had to write two lines to see anything.
 *
 * So the plan declares how to try the result, and a tool actually does it.
 * A contract can be correct and still not run, and that is a defect no
 * assertion on the code can find.
 */

/** How to run the delivered thing, and what "working" looks like. */
export interface TrySpec {
  /** The command that starts it. */
  command: string;
  /** A URL to poll until the thing answers, if it serves anything. */
  url?: string;
  /** How long to wait for readiness before giving up. */
  readyTimeoutMs?: number;
  /** What the response should look like once it is up. */
  expect?: {
    status?: number;
    bodyContains?: string;
  };
  /** A line in the command's output that means it is ready. */
  readyLine?: string;
}

export interface TryOutcome {
  ok: boolean;
  /** What the founder would see. */
  detail: string;
  /** The command's own output, trimmed. */
  output: string;
  /** The response body, if the spec asked for one. */
  body?: string;
  status?: number;
  elapsedMs: number;
  /** Why it failed, if it did. */
  reason?: string;
}

const DEFAULT_READY_TIMEOUT = 20_000;

/**
 * Run the delivered thing and report whether it actually works.
 *
 * Deliberately mechanical. It starts the command, waits for it to answer,
 * checks the response, and stops it. It does not judge whether the output is
 * good — that is what the DEBUG file is for.
 */
export async function tryIt(spec: TrySpec, cwd: string): Promise<TryOutcome> {
  const started = Date.now();
  const timeout = spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT;

  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let output = "";
  let child: ReturnType<typeof Bun.spawn> | undefined;

  try {
    child = Bun.spawn(["sh", "-c", spec.command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    // Drain both streams so the child never blocks on a full pipe.
    const decoder = new TextDecoder();
    const drain = (async () => {
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        // Bun's spawn gives a ReadableStream, not a Node stream, so read it
        // through a reader rather than an async iterator.
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          output += decoder.decode(value);
          if (output.length > 20_000) output = output.slice(-20_000);
        }
      }
    })();
    drain.catch(() => {});

    // Readiness: either the command prints a line, or the URL answers.
    const ready = await waitForReady(spec, timeout, () => output);
    if (!ready.ok) {
      return {
        ok: false,
        detail: `The command did not become ready within ${timeout}ms.`,
        output: output.trim(),
        elapsedMs: Date.now() - started,
        reason: ready.reason,
      };
    }

    // If a URL was given, check the response.
    if (spec.url) {
      const response = await fetch(spec.url, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
      if (!response) {
        return {
          ok: false,
          detail: `Nothing answered ${spec.url}.`,
          output: output.trim(),
          elapsedMs: Date.now() - started,
          reason: "no-response",
        };
      }
      const body = await response.text();
      const status = response.status;

      if (spec.expect?.status !== undefined && status !== spec.expect.status) {
        return {
          ok: false,
          detail: `${spec.url} answered ${status}, expected ${spec.expect.status}.`,
          output: output.trim(),
          body,
          status,
          elapsedMs: Date.now() - started,
          reason: "wrong-status",
        };
      }
      if (spec.expect?.bodyContains && !body.includes(spec.expect.bodyContains)) {
        return {
          ok: false,
          detail: `${spec.url} answered ${status} but the body did not contain ${JSON.stringify(spec.expect.bodyContains)}.`,
          output: output.trim(),
          body,
          status,
          elapsedMs: Date.now() - started,
          reason: "body-mismatch",
        };
      }

      return {
        ok: true,
        detail: `${spec.url} answered ${status}.`,
        output: output.trim(),
        body,
        status,
        elapsedMs: Date.now() - started,
      };
    }

    return {
      ok: true,
      detail: "The command started and reported ready.",
      output: output.trim(),
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `The command could not be run: ${error instanceof Error ? error.message : String(error)}`,
      output: output.trim(),
      elapsedMs: Date.now() - started,
      reason: "spawn-failed",
    };
  } finally {
    // The point is to try it, not to leave it running.
    child?.kill();
    void proc;
  }
}

async function waitForReady(
  spec: TrySpec,
  timeout: number,
  readOutput: () => string,
): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    // URL check is authoritative: a server answering HTTP is up regardless
    // of what its stdout says.
    if (spec.url) {
      const alive = await fetch(spec.url, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
      if (alive) return { ok: true };
    }
    if (spec.readyLine && readOutput().includes(spec.readyLine)) {
      return { ok: true };
    }
    if (!spec.readyLine && !spec.url) {
      // Nothing to wait for: a command that starts and stays up is ready.
      await Bun.sleep(250);
      return { ok: true };
    }
    await Bun.sleep(250);
  }

  return {
    ok: false,
    reason: spec.readyLine ? "no-ready-line" : "never-answered",
  };
}

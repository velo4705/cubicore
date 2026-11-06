/**
 * Running the result.
 *
 * Your org chart says the Main agent should "address how to make the project
 * work once the project is done". That step did not exist, and its absence
 * had a visible consequence: a completed, fully-passing toolkit that could
 * not be started. `listen()` was there, every check was green, and the founder
 * still had to write two lines to see anything.
 *
 * So the plan declares how to preview the result, and a tool actually does it.
 * A contract can be correct and still not run, and that is a defect no
 * assertion on the code can find.
 */

import { existsSync } from "node:fs";

/** How to run the delivered thing, and what "working" looks like — for any platform. */
export interface PreviewSpec {
  /** The command that starts it. */
  command: string;
  /** A URL to poll until the thing answers, if it serves anything (web apps). */
  url?: string;
  /** How long to wait for readiness before giving up. */
  readyTimeoutMs?: number;
  /** What the response or output should look like once it is up. */
  expect?: {
    status?: number;
    bodyContains?: string;
    /** A string somewhere in the command's output that means it actually works. */
    outputContains?: string;
  };
  /** A line in the command's output that means it is ready. */
  readyLine?: string;
}

export interface PreviewOutcome {
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
/**
 * Resolve a PATH that can actually run node-based commands.
 *
 * The MCP server inherits the host's environment, which on Nix (and many
 * other setups) has node on PATH but not npm, or neither. Rather than make
 * the founder hand-edit PATH, detect where node lives and prepend its
 * directory so npm -- which ships alongside node -- can be found.
 */
export function nodePathEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const existingPath = env.PATH || "";

  // Wherever node is, npm sits right next to it. Try the nix store path
  // first (common on NixOS and Nix-installed systems), then fall back to
  // asking the shell.
  const nodeDirs: string[] = [];

  // Heuristic: the nix store path for nodejs-slim-*/bin contains both
  // node and npm. Scan for it without guessing the exact hash.
  try {
    const { stdout } = Bun.spawnSync(["sh", "-c", "ls -d /nix/store/*/nodejs-*/bin 2>/dev/null | head -1"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const found = stdout.toString().trim().split("\n").filter(Boolean);
    nodeDirs.push(...found);
  } catch {
    // Ignore; we'll try `which` below.
  }

  // Ask the shell where node is, as a fallback.
  try {
    const { stdout } = Bun.spawnSync(["sh", "-c", "command -v node || command -v nodejs || true"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const nodeBin = stdout.toString().trim();
    if (nodeBin) {
      // directory of the node binary, which also holds npm
      nodeDirs.push(nodeBin.slice(0, nodeBin.lastIndexOf("/")));
    }
  } catch {
    // Ignore.
  }

  for (const dir of nodeDirs) {
    if (dir && !existingPath.split(":").includes(dir)) {
      env.PATH = `${dir}:${existingPath}`;
      break;
    }
  }

  return env;
}

export async function previewCheckOnce(spec: PreviewSpec, cwd: string): Promise<PreviewOutcome> {
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
      env: nodePathEnv(),
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

    if (spec.expect?.outputContains && !output.includes(spec.expect.outputContains)) {
      return {
        ok: false,
        detail: `The command started but its output did not contain ${JSON.stringify(spec.expect.outputContains)}.`,
        output: output.trim(),
        elapsedMs: Date.now() - started,
        reason: "output-mismatch",
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
  spec: PreviewSpec,
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
    if (spec.expect?.outputContains && readOutput().includes(spec.expect.outputContains)) {
      return { ok: true };
    }
    if (!spec.readyLine && !spec.url && !spec.expect?.outputContains) {
      // Nothing to wait for: a command that starts and stays up is ready.
      await Bun.sleep(250);
      return { ok: true };
    }
    await Bun.sleep(250);
  }

  return {
    ok: false,
    reason: spec.readyLine ? "no-ready-line" : spec.expect?.outputContains ? "no-matching-output" : "never-answered",
  };
}

/** Kill a process group (POSIX). On non-POSIX, falls back to kill the pid. */
function killProcessGroup(pid: number): void {
  try {
    // eslint-disable-next-line no-underscore-dangle
    if (typeof process !== "undefined" && process.kill) {
      try {
        // Negative pid means kill the process group on POSIX
        process.kill(-pid, "SIGTERM");
        return;
      } catch (_) {
        /* ignored */
      }
    }
    // Fallback: try to kill the pid itself (best effort on Windows)
    try {
      if (typeof process !== "undefined" && process.kill) process.kill(pid, "SIGTERM");
    } catch (_) {
      /* ignored */
    }
  } catch (_) {
    /* ignored */
  }
}

export interface PreviewStartOutcome extends PreviewOutcome {
  /** The detached preview process, retained for the founder to use. */
  pid?: number;
}

async function runAndVerify(spec: PreviewSpec, cwd: string, command: string): Promise<PreviewStartOutcome> {
  const started = Date.now();
  const timeout = spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT;
  let output = "";
  let child: ReturnType<typeof Bun.spawn> | undefined;

  try {
    child = Bun.spawn(["sh", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: nodePathEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
const pid = child.pid;
    if (!pid) {
      return {
        ok: false,
        detail: "Failed to obtain a PID from the preview process.",
        output: output.trim(),
        elapsedMs: Date.now() - started,
        reason: "spawn-failed",
      };
    }

    // Drain both streams so a noisy command cannot block waiting for a pipe.
    const decoder = new TextDecoder();
    const drain = (async () => {
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
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

    const ready = await waitForReady(spec, timeout, () => output);

    // A command that was "ready" only because there was nothing to wait for may
    // have already crashed (missing native module, missing display). Do not
    // report success for a dead process.
    const strongReady = Boolean(spec.url || spec.readyLine || spec.expect?.outputContains);
    if (!strongReady) {
      const early = await Promise.race([
        child.exited.then((exitCode) => ({ exited: true, exitCode })),
        Bun.sleep(50).then(() => ({ exited: false, exitCode: null as number | null })),
      ]);
      if (early.exited) {
        return {
          ok: false,
          detail: `The command exited during startup (exit code ${early.exitCode}).`,
          output: output.trim(),
          elapsedMs: Date.now() - started,
          reason: "exited-early",
        };
      }
    }

    if (!ready.ok) {
      if (child?.exitCode === null) killProcessGroup(pid);
      return {
        ok: false,
        detail: `The command did not become ready within ${timeout}ms.`,
        output: output.trim(),
        elapsedMs: Date.now() - started,
        reason: ready.reason,
      };
    }

    // If a URL was given, make sure it answered the way the plan said it would.
    if (spec.url) {
      const response = await fetch(spec.url, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
      if (!response) {
        killProcessGroup(pid);
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
        killProcessGroup(pid);
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
        killProcessGroup(pid);
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

      await writePreviewState(cwd, { pid, url: spec.url, startedAt: Date.now() });
      return {
        ok: true,
        detail: `${spec.url} answered ${status}. Preview is still running.`,
        output: output.trim(),
        body,
        status,
        elapsedMs: Date.now() - started,
        pid,
      };
    }

    if (spec.expect?.outputContains && !output.includes(spec.expect.outputContains)) {
      killProcessGroup(pid);
      return {
        ok: false,
        detail: `The command started but its output did not contain ${JSON.stringify(spec.expect.outputContains)}.`,
        output: output.trim(),
        elapsedMs: Date.now() - started,
        reason: "output-mismatch",
      };
    }

    await writePreviewState(cwd, { pid, url: "", startedAt: Date.now() });
    return {
      ok: true,
      detail: "The command started and is still running.",
      output: output.trim(),
      elapsedMs: Date.now() - started,
      pid,
    };
  } catch (error) {
    const pid = child?.pid;
    if (pid) killProcessGroup(pid);
    return {
      ok: false,
      detail: `The command could not be run: ${error instanceof Error ? error.message : String(error)}`,
      output: output.trim(),
      elapsedMs: Date.now() - started,
      reason: "spawn-failed",
    };
  }
}


/** True when the output tells us this is an environment problem, not an app defect. */
function isEnvironmentBlocker(output: string): boolean {
  return /ModuleNotFoundError|_tkinter|TclError|cannot open display|Could not open display|$DISPLAY|DISPLAY is not set|No protocol specified|xhost:|unable to initialize GTK/i.test(output);
}

/** True when DISPLAY points at an X socket this process can reach. */
function displayReachable(display?: string): boolean {
  if (!display) return false;
  const m = /^:(\d+)$/.exec(display.trim());
  if (!m) return false;
  try {
    return existsSync(`/tmp/.X11-unix/X${m[1]}`);
  } catch {
    return false;
  }
}

function commandExistsSync(name: string): boolean {
  try {
    const { stdout, exitCode } = Bun.spawnSync(["sh", "-c", `command -v ${name} >/dev/null 2>&1; printf %s "$?"`], { stdout: "pipe", stderr: "pipe", env: nodePathEnv() });
    return stdout.toString().trim() === "0";
  } catch {
    return false;
  }
}

/**
 * Start the delivered thing and keep it running.
 *
 * Preview goes through the founder's own way to run the app first. When the
 * host cannot deliver it that way, it tries environment fallbacks before
 * giving up: if a real X display is reachable, retry under a Nix python that
 * includes tkinter (so the window appears on the founder's desktop); else
 * retry under xvfb-run (and, for Python-with-missing-tkinter hosts, under a
 * Nix expression with python3+tkinter and xvfb-run). so a headless box can
 * verify a GUI and a desktop box lands it on screen.
 */
export async function previewIt(spec: PreviewSpec, cwd: string): Promise<PreviewStartOutcome> {
  const primary = await runAndVerify(spec, cwd, spec.command);
  if (primary.ok) return primary;
  if (!isEnvironmentBlocker(primary.output)) return primary;

  // The desktop works and the app needs a tk that the system python lacks:
  // prefer the real display over a private Xvfb when one is reachable.
  if (displayReachable(process.env.DISPLAY) && commandExistsSync("nix") && /_tkinter|No module named/i.test(primary.output)) {
    const retry = await runAndVerify(
      spec,
      cwd,
      `nix --extra-experimental-features 'nix-command flakes' shell --impure --expr 'with import (builtins.getFlake "nixpkgs") {}; (python3.withPackages (ps: [ ps.tkinter ]))' -c ${spec.command}`,
    );
    if (retry.ok) {
      retry.detail = `Started via Nix (python3+tkinter) on the real display ${process.env.DISPLAY}: ${retry.detail}`;
      return retry;
    }
    return retry;
  }

  if (!displayReachable(process.env.DISPLAY) && commandExistsSync("xvfb-run")) {
    const retry = await runAndVerify(spec, cwd, `xvfb-run -a ${spec.command}`);
    if (retry.ok) {
      retry.detail = `Started under xvfb-run (host has no display): ${retry.detail}`;
      return retry;
    }
  }

  if (/^(python3?|python)\b/.test(spec.command) && commandExistsSync("nix") && /_tkinter|No module named/i.test(primary.output)) {
    const retry = await runAndVerify(
      spec,
      cwd,
      `nix --extra-experimental-features 'nix-command flakes' shell --impure --expr 'with import (builtins.getFlake "nixpkgs") {}; [ (python3.withPackages (ps: [ ps.tkinter ])) xorgserver xvfb-run ]' -c xvfb-run -a ${spec.command}`,
    );
    if (retry.ok) {
      retry.detail = `Started via Nix with python3+tkinter under xvfb-run: ${retry.detail}`;
      return retry;
    }
    retry.detail = retry.detail + `\nHost is missing tkinter for its system Python. Install it (e.g. python3-tk) or keep using the Nix expression shown in the output.`;
    return retry;
  }

  primary.detail = `${primary.detail}\nThis host is missing what the command needs (missing native module or display server). Install it, or run the command under an environment that provides it.`;
  return primary;
}
async function writePreviewState(
  cwd: string,
  state: { pid: number; url: string; startedAt: number },
): Promise<void> {
  try {
    await Bun.write(`${cwd}/.cubicore-preview.json`, JSON.stringify({ ...state, cwd }, null, 2));
  } catch {
    // Non-fatal: the preview is still usable; the stop path just cannot read state.
  }
}

/**
 * Stop a preview server started by /cubicore:preview.
 * Reads the preview state file, kills the process group, and deletes the file.
 * Returns an object with ok and detail.
 */
export async function stopIt(cwd: string): Promise<{ ok: boolean; detail: string }> {
  const previewStatePath = `${cwd}/.cubicore-preview.json`;
  try {
    const raw = await Bun.file(previewStatePath).text();
    const state = JSON.parse(raw);
    const { pid, url } = state;
    if (typeof pid !== "number") {
      return { ok: false, detail: "Invalid preview state file: missing or invalid PID." };
    }
    killProcessGroup(pid);
    // Delete the file
    try {
      await Bun.file(previewStatePath).delete();
    } catch {
      // Ignore deletion errors
    }
    return { ok: true, detail: `Stopped preview server (PID ${pid}) at ${url}.` };
  } catch (e) {
    if (e instanceof Error && ("code" in e) && e.code === "ENOENT") {
      return { ok: false, detail: "No preview server is running." };
    }
    return { ok: false, detail: `Failed to stop preview server: ${e instanceof Error ? e.message : String(e)}` };
  }
}

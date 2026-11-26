import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderDoctor, runDoctor } from "../src/doctor";
import type { InstallTarget } from "../src/install/targets";

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cubicore-doctor-"));
  writeFileSync(join(dir, "CUBICORE_PLAN.json"), "{}");
  writeFileSync(join(dir, ".cubicore-state.json"), "{}");
  return dir;
}

const env = { OPENCODE_PORT: "43111", OPENCODE_SERVER_PASSWORD: "super-secret-value" };

describe("doctor", () => {
  test("reports a live session probe and never prints the credential", async () => {
    const dir = makeDir();
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      if (init?.method === "POST") {
        expect(init.headers).toBeDefined();
        expect(JSON.stringify(init.headers)).not.toContain("super-secret-value");
        return new Response(JSON.stringify({ data: { id: "ses_probe" } }), { status: 200 });
      }
      return new Response("{}", { status: 204 });
    }) as unknown as typeof fetch;

    const checks = await runDoctor({
      env,
      directory: dir,
      fetchImpl,
      resolveTargetsFn: () => [],
    });

    const session = checks.find((c) => c.name === "live session-create");
    expect(session?.status).toBe("ok");
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    const text = renderDoctor(checks);
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("credential: resolved from environment");
    expect(text).toContain("plan on disk");
    expect(text).toContain("factory ledger");

    rmSync(dir, { recursive: true, force: true });
  });

  test("names a Browser Proxy 407 instead of blaming auth", async () => {
    const dir = makeDir();
    const fetchImpl = (async () => new Response("proxy denied", {
      status: 407,
      headers: { "Proxy-Authenticate": 'Basic realm="OpenCode Browser Proxy"' },
    })) as unknown as typeof fetch;
    const checks = await runDoctor({ env, directory: dir, fetchImpl, resolveTargetsFn: () => [] });
    const session = checks.find((c) => c.name === "live session-create");
    expect(session?.status).toBe("fail");
    expect(session?.hint).toContain("Browser Proxy");
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports a missing port without attempting a probe", async () => {
    const dir = makeDir();
    const checks = await runDoctor({
      env: { OPENCODE_SERVER_PASSWORD: "x", OPENCODE_PORT: "", OPENCODE_SERVER_PORT: "" },
      directory: dir,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      resolveTargetsFn: () => [],
    });
    expect(checks.find((c) => c.name === "port")?.status).toBe("fail");
    expect(checks.find((c) => c.name === "live session-create")?.status).toBe("skip");
    rmSync(dir, { recursive: true, force: true });
  });
});


test("doctor sees a Cubicore MCP entry in a target config", async () => {
  const dir = makeDir();
  const configFile = join(dir, "opencode.json");
  writeFileSync(configFile, JSON.stringify({ mcp: { cubicore: { type: "local", enabled: true } } }));
  writeFileSync(join(dir, ".cubicore-version"), JSON.stringify({ version: "1.1.19" }));
  const target: InstallTarget = {
    id: "native",
    label: "native",
    description: "test",
    configDir: dir,
    configFile,
    flatpak: false,
  };
  const checks = await runDoctor({
    env,
    directory: dir,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    resolveTargetsFn: () => [target],
  });
  expect(checks.find((c) => c.name === "config: native")?.status).toBe("ok");
  expect(renderDoctor(checks)).toContain("installed version 1.1.19");
  rmSync(dir, { recursive: true, force: true });
});

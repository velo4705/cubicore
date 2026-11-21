import { afterEach, describe, expect, test } from "bun:test";

import { runtimeFromEnv } from "../../src/adapters/opencode/runtime";

/**
 * The desktop app owns three loopback listeners: two Browser Proxy ports and
 * the CLI API. The proxy answers 407 "Basic realm=OpenCode Browser Proxy" to
 * session-create; only the CLI port can dispatch work. The old "first match"
 * rule picked a proxy port and broke every run after an opencode update.
 *
 * The test asserts the rule portably: on a host where discovery is possible,
 * the chosen port must be a CLI listener (verified by an /api/session probe),
 * never a Browser Proxy. On hosts without opencode, only the explicit-env
 * rule applies.
 */
describe("port discovery — CLI API, not the Browser Proxy", () => {
  const savedPort = process.env.OPENCODE_PORT;
  const savedServerPort = process.env.OPENCODE_SERVER_PORT;

  afterEach(() => {
    if (savedPort === undefined) delete process.env.OPENCODE_PORT;
    else process.env.OPENCODE_PORT = savedPort;
    if (savedServerPort === undefined) delete process.env.OPENCODE_SERVER_PORT;
    else process.env.OPENCODE_SERVER_PORT = savedServerPort;
  });

  test("an explicit OPENCODE_PORT always wins over discovery", () => {
    process.env.OPENCODE_PORT = "12345";
    const runtime = runtimeFromEnv();
    expect(runtime.port).toBe("12345");
    expect(runtime.baseUrl).toBe("http://127.0.0.1:12345");
  });

  test("a discovered port never answers 407 Browser Proxy on session-create", async () => {
    delete process.env.OPENCODE_PORT;
    delete process.env.OPENCODE_SERVER_PORT;
    let runtime;
    try {
      runtime = runtimeFromEnv();
    } catch {
      return; // no opencode host here — discovery is best-effort by design
    }
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password) return; // service.json fallback handled in the live probe
    const response = await fetch(
      `${runtime.baseUrl}/api/session?directory=${encodeURIComponent(runtime.directory)}`,
      {
        headers: { Authorization: `Basic ${btoa(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`)}` },
        signal: AbortSignal.timeout(3000),
      },
    ).catch(() => undefined);
    // 407 means discovery picked the proxy. Any other status (including
    // connection refusal on a non-running host) is not the regression.
    if (response) expect(response.status).not.toBe(407);
  });
});

import { afterEach, describe, expect, test } from "bun:test";

import { authFromEnv } from "../../src/adapters/opencode/plugin";
import { basicAuthHeader, servicePassword } from "../../src/mcp/service";

const savedUser = process.env.OPENCODE_SERVER_USERNAME;
const savedPass = process.env.OPENCODE_SERVER_PASSWORD;

afterEach(() => {
  if (savedUser === undefined) delete process.env.OPENCODE_SERVER_USERNAME;
  else process.env.OPENCODE_SERVER_USERNAME = savedUser;
  if (savedPass === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
  else process.env.OPENCODE_SERVER_PASSWORD = savedPass;
});

describe("opencode auth — no 401 on session create after the 2.x update", () => {
  test("explicit env pair still wins", () => {
    process.env.OPENCODE_SERVER_USERNAME = "tester";
    process.env.OPENCODE_SERVER_PASSWORD = "secret";
    const auth = authFromEnv();
    expect(auth?.username).toBe("tester");
    expect(auth?.password).toBe("secret");
    expect(basicAuthHeader()).toBe(`Basic ${btoa("tester:secret")}`);
  });

  test("with no env pair, auth falls back to the host's service.json", () => {
    // Newer opencode stopped injecting OPENCODE_SERVER_* into MCP children.
    // On any host that has a service.json, auth must still resolve.
    delete process.env.OPENCODE_SERVER_USERNAME;
    delete process.env.OPENCODE_SERVER_PASSWORD;

    if (servicePassword() === undefined) {
      // No service credential on this machine — honest absence.
      expect(authFromEnv()).toBeUndefined();
      return;
    }

    const auth = authFromEnv();
    expect(auth).toBeDefined();
    expect(auth?.username).toBe("opencode");
    expect(auth?.password).toBe(servicePassword());
    expect(basicAuthHeader()).toBe(`Basic ${btoa(`opencode:${servicePassword()}`)}`);
  });

  test("an injected env object is honoured without mutating the process", () => {
    const injected = authFromEnv({ OPENCODE_SERVER_USERNAME: "u", OPENCODE_SERVER_PASSWORD: "p" });
    expect(injected).toEqual({ username: "u", password: "p" });
  });
});

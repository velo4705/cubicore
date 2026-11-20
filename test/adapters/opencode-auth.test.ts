import { afterEach, describe, expect, test } from "bun:test";

import { authFromEnv } from "../../src/adapters/opencode/plugin";
import { basicAuthHeader, servicePassword, resolveCredential } from "../../src/mcp/service";

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


describe("credential rotation / path changes", () => {
  const savedConfig = process.env.OPENCODE_CONFIG_DIR;
  const savedXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (savedConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = savedConfig;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  test("a credential at a brand-new OPENCODE_CONFIG_DIR is found", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cubicore-rotate-"));
    try {
      writeFileSync(join(dir, "service.json"), JSON.stringify({ password: "rotated-new-path" }));
      delete process.env.OPENCODE_SERVER_PASSWORD;
      process.env.OPENCODE_CONFIG_DIR = dir;
      const cred = resolveCredential();
      expect(cred?.password).toBe("rotated-new-path");
      expect(cred?.label).toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rotation at the same path is picked up on the next resolution", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cubicore-rotate-"));
    try {
      const file = join(dir, "service.json");
      delete process.env.OPENCODE_SERVER_PASSWORD;
      process.env.OPENCODE_CONFIG_DIR = dir;
      writeFileSync(file, JSON.stringify({ password: "before-rotation" }));
      expect(resolveCredential()?.password).toBe("before-rotation");
      // opencode updates the file while the process is still alive
      writeFileSync(file, JSON.stringify({ password: "after-rotation" }));
      expect(resolveCredential()?.password).toBe("after-rotation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("environment pair still wins over service.json", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cubicore-rotate-"));
    try {
      writeFileSync(join(dir, "service.json"), JSON.stringify({ password: "from-file" }));
      process.env.OPENCODE_CONFIG_DIR = dir;
      process.env.OPENCODE_SERVER_USERNAME = "envuser";
      process.env.OPENCODE_SERVER_PASSWORD = "envpass";
      const cred = resolveCredential();
      expect(cred?.label).toBe("environment");
      expect(cred?.password).toBe("envpass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

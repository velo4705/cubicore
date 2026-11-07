import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import {
  dataDir,
  resolveBun,
  resolveFlatpakTarget,
  resolveNativeTarget,
  resolveTargets,
} from "../src/install/targets";
import { parseJsonc, stripJsonc } from "../src/install/jsonc";

/** exists() backed by a fixed set of paths. */
const only =
  (paths: string[]) =>
  (path: string): boolean =>
    paths.includes(path);

const HOME = "/home/tester";

describe("resolveNativeTarget", () => {
  it("defaults to ~/.config/opencode/opencode.json on Linux", () => {
    const target = resolveNativeTarget({
      platform: "linux",
      home: HOME,
      env: {},
      exists: only([]),
    });
    expect(target.configDir).toBe(join(HOME, ".config", "opencode"));
    expect(target.configFile).toBe(join(HOME, ".config", "opencode", "opencode.json"));
    expect(target.flatpak).toBe(false);
  });

  it("uses ~/.config/opencode on Windows too (%USERPROFILE%\\.config\\opencode)", () => {
    const target = resolveNativeTarget({
      platform: "win32",
      home: "C:\\Users\\tester",
      env: {},
      exists: only([]),
    });
    expect(target.configDir).toBe(join("C:\\Users\\tester", ".config", "opencode"));
    expect(target.configFile).toContain("opencode.json");
  });

  it("honours XDG_CONFIG_HOME when set", () => {
    const target = resolveNativeTarget({
      platform: "linux",
      home: HOME,
      env: { XDG_CONFIG_HOME: "/custom/xdg" },
      exists: only([]),
    });
    expect(target.configDir).toBe(join("/custom/xdg", "opencode"));
  });

  it("ignores a blank XDG_CONFIG_HOME", () => {
    const target = resolveNativeTarget({
      platform: "linux",
      home: HOME,
      env: { XDG_CONFIG_HOME: "   " },
      exists: only([]),
    });
    expect(target.configDir).toBe(join(HOME, ".config", "opencode"));
  });

  it("an explicit OPENCODE_CONFIG file wins over everything", () => {
    const target = resolveNativeTarget({
      platform: "linux",
      home: HOME,
      env: {
        OPENCODE_CONFIG: "/elsewhere/my-config.json",
        OPENCODE_CONFIG_DIR: "/ignored",
        XDG_CONFIG_HOME: "/also-ignored",
      },
      exists: only(["/elsewhere/my-config.json"]),
    });
    expect(target.configFile).toBe("/elsewhere/my-config.json");
    expect(target.configDir).toBe("/elsewhere");
  });

  it("OPENCODE_CONFIG_DIR replaces the standard directory", () => {
    const target = resolveNativeTarget({
      platform: "linux",
      home: HOME,
      env: { OPENCODE_CONFIG_DIR: "/team/opencode" },
      exists: only([]),
    });
    expect(target.configDir).toBe("/team/opencode");
    expect(target.configFile).toBe(join("/team/opencode", "opencode.json"));
  });

  it("prefers opencode.json when both json and jsonc exist", () => {
    const dir = join(HOME, ".config", "opencode");
    const target = resolveNativeTarget({
      platform: "linux",
      home: HOME,
      env: {},
      exists: only([join(dir, "opencode.json"), join(dir, "opencode.jsonc")]),
    });
    expect(target.configFile).toBe(join(dir, "opencode.json"));
  });

  it("falls back to opencode.jsonc when no json exists", () => {
    const dir = join(HOME, ".config", "opencode");
    const target = resolveNativeTarget({
      platform: "linux",
      home: HOME,
      env: {},
      exists: only([join(dir, "opencode.jsonc")]),
    });
    expect(target.configFile).toBe(join(dir, "opencode.jsonc"));
  });
});

describe("resolveFlatpakTarget", () => {
  it("exists on Linux", () => {
    const target = resolveFlatpakTarget({
      platform: "linux",
      home: HOME,
      env: {},
      exists: only([]),
    });
    expect(target).not.toBeNull();
    expect(target?.configDir).toBe(
      join(HOME, ".var", "app", "ai.opencode.opencode", "config", "opencode"),
    );
  });

  it("does not exist on macOS or Windows", () => {
    expect(
      resolveFlatpakTarget({ platform: "darwin", home: HOME, env: {}, exists: only([]) }),
    ).toBeNull();
    expect(
      resolveFlatpakTarget({ platform: "win32", home: HOME, env: {}, exists: only([]) }),
    ).toBeNull();
  });

  it("resolveTargets hides Flatpak off Linux", () => {
    expect(resolveTargets({ platform: "darwin", home: HOME, env: {}, exists: only([]) }).map((t) => t.id)).toEqual(["native"]);
    expect(resolveTargets({ platform: "linux", home: HOME, env: {}, exists: only([]) }).map((t) => t.id)).toEqual(["native", "flatpak"]);
  });
});

describe("resolveBun", () => {
  it("finds bun via BUN_INSTALL", () => {
    const bun = resolveBun({
      platform: "linux",
      home: HOME,
      env: { BUN_INSTALL: "/opt/bun" },
      exists: only([join("/opt/bun", "bin", "bun")]),
    });
    expect(bun.absolute).toBe(join("/opt/bun", "bin", "bun"));
    expect(bun.command("/x/mcp-main.js")).toEqual([join("/opt/bun", "bin", "bun"), "/x/mcp-main.js"]);
  });

  it("finds bun via the default ~/.bun/bin location", () => {
    const bun = resolveBun({
      platform: "linux",
      home: HOME,
      env: {},
      exists: only([join(HOME, ".bun", "bin", "bun")]),
    });
    expect(bun.absolute).toBe(join(HOME, ".bun", "bin", "bun"));
  });

  it("finds bun through PATH", () => {
    const bun = resolveBun({
      platform: "linux",
      home: HOME,
      env: { PATH: "/usr/bin:/tools/bin" },
      exists: only(["/tools/bin/bun"]),
    });
    expect(bun.absolute).toBe("/tools/bin/bun");
  });

  it("finds bun.exe on Windows", () => {
    const bun = resolveBun({
      platform: "win32",
      home: "C:\\Users\\tester",
      env: { PATH: "C:\\tools" },
      exists: only([join("C:\\tools", "bun.exe")]),
    });
    expect(bun.absolute).toBe(join("C:\\tools", "bun.exe"));
  });

  it("falls back to npx bun when no local bun exists", () => {
    const bun = resolveBun({
      platform: "linux",
      home: HOME,
      env: {},
      exists: only([]),
    });
    expect(bun.absolute).toBeNull();
    expect(bun.command("/x/mcp-main.js")).toEqual(["npx", "--yes", "bun", "/x/mcp-main.js"]);
  });

  it("wraps the npx fallback in cmd /c on Windows (.cmd shim)", () => {
    const bun = resolveBun({
      platform: "win32",
      home: "C:\\Users\\t",
      env: {},
      exists: only([]),
    });
    expect(bun.absolute).toBeNull();
    expect(bun.command("C:\\x\\mcp-main.js")).toEqual([
      "cmd",
      "/c",
      "npx",
      "--yes",
      "bun",
      "C:\\x\\mcp-main.js",
    ]);
  });
});

describe("dataDir", () => {
  it("uses XDG_DATA_HOME on Linux when set", () => {
    expect(dataDir({ platform: "linux", home: HOME, env: { XDG_DATA_HOME: "/data" } })).toBe(
      join("/data", "cubicore"),
    );
  });

  it("defaults to ~/.local/share/cubicore on Linux", () => {
    expect(dataDir({ platform: "linux", home: HOME, env: {} })).toBe(
      join(HOME, ".local", "share", "cubicore"),
    );
  });

  it("uses %LOCALAPPDATA%\\cubicore on Windows", () => {
    expect(
      dataDir({ platform: "win32", home: "C:\\Users\\t", env: { LOCALAPPDATA: "C:\\Local" } }),
    ).toBe(join("C:\\Local", "cubicore"));
  });

  it("uses ~/Library/Application Support/cubicore on macOS", () => {
    expect(dataDir({ platform: "darwin", home: "/Users/t", env: {} })).toBe(
      join("/Users/t", "Library", "Application Support", "cubicore"),
    );
  });
});

describe("parseJsonc", () => {
  it("parses plain JSON unchanged", () => {
    expect(parseJsonc('{"a": 1, "b": [1, 2]}')).toEqual({ a: 1, b: [1, 2] });
  });

  it("strips line and block comments", () => {
    const text = `{
      // a line comment
      "a": 1, /* inline block */ "b": 2,
      /* multi
         line */
      "c": 3
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("keeps URLs inside strings intact", () => {
    const text = '{ "$schema": "https://opencode.ai/config.json", "url": "http://example.com/a//b" }';
    expect(parseJsonc(text)).toEqual({
      $schema: "https://opencode.ai/config.json",
      url: "http://example.com/a//b",
    });
  });

  it("keeps comment-like sequences inside strings", () => {
    const text = '{ "note": "this // is not a comment", "block": "/* nor this */" }';
    expect(parseJsonc(text)).toEqual({ note: "this // is not a comment", block: "/* nor this */" });
  });

  it("removes trailing commas in objects and arrays", () => {
    const text = `{
      "list": [1, 2, 3,],
      "nested": { "a": 1, "b": 2, },
    }`;
    expect(parseJsonc(text)).toEqual({ list: [1, 2, 3], nested: { a: 1, b: 2 } });
  });

  it("removes trailing commas before a newline+brace", () => {
    expect(parseJsonc('{ "a": 1,\n}')).toEqual({ a: 1 });
  });

  it("handles escaped quotes inside strings", () => {
    expect(parseJsonc('{ "a": "he said \\"hi, },\\" twice" }')).toEqual({ a: 'he said "hi, }," twice' });
  });

  it("throws on garbage", () => {
    expect(() => parseJsonc("{ not json at all ]")).toThrow();
  });

  it("round-trips a realistic opencode.jsonc", () => {
    const text = `{
      // Cubicore lives under mcp.cubicore
      "$schema": "https://opencode.ai/config.json",
      "provider": {
        "opencode": { "models": { "crouton-alpha-free": { "name": "x", }, }, }, // trailing commas everywhere
      },
      "mcp": {},
    }`;
    expect(parseJsonc(text)).toEqual({
      $schema: "https://opencode.ai/config.json",
      provider: { opencode: { models: { "crouton-alpha-free": { name: "x" } } } },
      mcp: {},
    });
  });

  it("stripJsonc is idempotent on comment-free input", () => {
    const strict = '{ "a": [1, { "b": "c, d" }], }';
    expect(stripJsonc(strict)).toBe('{ "a": [1, { "b": "c, d" }] }');
  });
});

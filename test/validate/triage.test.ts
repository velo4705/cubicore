import { describe, expect, test } from "bun:test";

import { classifyCheckFailure, type CheckFailureKind } from "../../src/validate/triage";

describe("classifyCheckFailure", () => {
  const kinds = ["environment", "code", "format", "spec", "budget", "unknown"] as const;

  test("the six buckets are exhaustive", () => {
    expect(new Set(kinds).size).toBe(6);
  });

  test("environment — missing tool", () => {
    expect(classifyCheckFailure("sh: 1: tsc: command not found")).toBe("environment");
    expect(classifyCheckFailure("Error: Cannot find module 'foo'")).toBe("environment");
    expect(classifyCheckFailure("ENOENT: no such file or directory, open '/usr/local/bin/nope'")).toBe("environment");
  });

  test("environment — EACCES permission", () => {
    expect(classifyCheckFailure("EPERM: operation not permitted, chmod '/sandbox/-x'")).toBe("environment");
  });

  test("environment — engine constraint", () => {
    expect(classifyCheckFailure("error Unsupported engine: node is required >= 20")).toBe("environment");
  });

  test("format — lint output", () => {
    expect(classifyCheckFailure("src/index.ts\n  12:1  error  Prettier print width expected 80  prettier/prettier")).toBe("format");
    expect(classifyCheckFailure("[eslint] src/app.ts: 'foo' is not defined")).toBe("format");
  });

  test("format — formatting tool clean complaint", () => {
    expect(classifyCheckFailure("Running Prettier on sources...")).toBe("format");
  });

  test("code — TypeScript errors", () => {
    expect(classifyCheckFailure("src/app.ts(7,10): error TS2322: Type 'string' is not assignable to type 'number'.")).toBe("code");
    expect(classifyCheckFailure("ReferenceError: foo is not defined")).toBe("code");
  });

  test("code — SyntaxError", () => {
    expect(classifyCheckFailure("SyntaxError: Unexpected token '<' at Module._compile")).toBe("code");
  });

  test("code — runtime TypeError", () => {
    expect(classifyCheckFailure("TypeError: Cannot read properties of undefined (reading 'id')")).toBe("code");
  });

  test("budget — OOM hint in output", () => {
    expect(classifyCheckFailure("FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory")).toBe("budget");
  });

  test("spec — Playwright locator timeout", () => {
    expect(classifyCheckFailure("TimeoutError: locator.click: Timeout 30000ms exceeded")).toBe("spec");
    expect(classifyCheckFailure("expect(page.getByRole('button')).toBeVisible")).toBe("spec");
  });

  test("unknown — nothing matched", () => {
    expect(classifyCheckFailure("some opaque stack trace with no useful token")).toBe("unknown");
    expect(classifyCheckFailure("")).toBe("unknown");
  });

  test("the classifier never throws on empty input", () => {
    expect(() => classifyCheckFailure("")).not.toThrow();
    expect(() => classifyCheckFailure(undefined as unknown as string)).not.toThrow();
  });
});

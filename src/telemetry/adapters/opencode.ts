import { EMPTY_USAGE, type TokenUsage } from "../types";

/**
 * opencode `message.updated` -> provider-agnostic `TokenUsage`.
 *
 * VERIFY BEFORE TRUSTING: the exact shape of the assistant token block is
 * inferred from a third-party plugin's storage schema, not from the SDK types,
 * because `@opencode-ai/sdk` is not installed in this repo yet. Two spellings
 * of the cache counters are handled because both are attested in the wild —
 * `cacheRead` flat, and nested under `cache`. Once the SDK is installed, check
 * this against the real `MessageInfo` and delete whichever branch is dead.
 */

interface FlatCacheShape {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

interface NestedCacheShape {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
  cost?: number;
}

type UsageShape = FlatCacheShape | NestedCacheShape;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasAnyUsage(shape: UsageShape): boolean {
  const keys = Object.keys(shape);
  if (keys.length === 0) return false;
  return ["input", "output", "reasoning", "cacheRead", "cacheWrite", "cache"].some(
    (key) => key in shape,
  );
}

/**
 * Returns null when the payload carries no usage — a user message, a tool part,
 * or any non-assistant event on the bus. Callers treat null as "ignore", which
 * is what keeps the ledger from recording zeroes for every event on the bus.
 */
export function readUsage(info: unknown): TokenUsage | null {
  if (!isRecord(info)) return null;
  if (isRecord(info.role) && info.role.type && info.role.type !== "assistant") {
    return null;
  }

  const tokens = info.tokens;
  if (!isRecord(tokens)) return null;

  const shape = tokens as UsageShape;
  if (!hasAnyUsage(shape)) return null;

  const nested = (shape as NestedCacheShape).cache;

  return {
    input: num(shape.input),
    output: num(shape.output),
    reasoning: num(shape.reasoning),
    cacheRead: num((shape as FlatCacheShape).cacheRead ?? nested?.read),
    cacheWrite: num((shape as FlatCacheShape).cacheWrite ?? nested?.write),
    cost: num(shape.cost),
  };
}

export const ZERO_USAGE = EMPTY_USAGE;
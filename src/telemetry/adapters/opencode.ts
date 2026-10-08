import type { TokenUsage } from "../types";

/**
 * opencode `message.updated` -> provider-agnostic `TokenUsage`.
 *
 * The token shape below was read from opencode's session database
 * (`~/.local/share/opencode/opencode-stable.db`, `message.data`), not inferred
 * from docs. An assistant row stores:
 *
 *   { input, output, reasoning, cache: { read, write } }
 *
 * Two corrections that came out of checking rather than guessing:
 *   - cache counters are **nested**, not flat `cacheRead` / `cacheWrite`
 *   - `cost` is a sibling of `tokens` on the message, not a field inside it
 *
 * If opencode changes the schema this is the one file to update, and the test
 * fixture is a verbatim copy of a real row.
 */

interface OpencodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Returns null when the payload carries no usage — a user message, a tool part,
 * or any non-assistant event on the bus. Callers treat null as "ignore", which
 * is what keeps the ledger from recording zeroes for every event.
 *
 * `cost` is read from the message, since it lives outside the token block.
 */
export function readUsage(info: unknown): TokenUsage | null {
  if (!isRecord(info)) return null;

  const role = info.role;
  if (typeof role === "string" && role !== "assistant") return null;
  if (isRecord(role) && role.type && role.type !== "assistant") return null;

  const tokens = info.tokens;
  if (!isRecord(tokens)) return null;

  const shape = tokens as OpencodeTokens;
  if (Object.keys(shape).length === 0) return null;

  return {
    input: num(shape.input),
    output: num(shape.output),
    reasoning: num(shape.reasoning),
    cacheRead: num(shape.cache?.read),
    cacheWrite: num(shape.cache?.write),
    cost: num(info.cost),
  };
}
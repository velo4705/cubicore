import { UsageLedger } from "../telemetry/usage";
import { EMPTY_USAGE, type TokenUsage } from "../telemetry/types";
import { readUsage } from "../telemetry/adapters/opencode";

/**
 * Reconstructs a worker run from the event bus.
 *
 * The plugin already receives every event, so observation needs no SDK client
 * and no extra request. That keeps the opencode-specific surface to one spawn
 * call rather than a session, a stream, and a usage endpoint.
 *
 * VERIFY BEFORE TRUSTING: the token block shape is inferred from a third-party
 * plugin's schema, not the installed SDK — see `adapters/opencode.ts`. The
 * `file.edited` field name is a single-attribute guess; both are the only
 * unverified reads in this file.
 */

export interface Observation {
  sessionId: string | null;
  usage: TokenUsage;
  toolCalls: number;
  changedFiles: string[];
  /** Assistant text parts, in arrival order. */
  texts: string[];
  started: boolean;
  idle: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * One observer per worker.
 *
 * The event bus is global, so every event is filtered by session. Attaching
 * after session creation is required because the id is the thing being
 * returned; events arriving before `attach` are dropped, which is why the
 * spawner attaches immediately.
 */
export class RunObserver {
  private sessionId: string | null = null;
  private readonly ledger = new UsageLedger();
  private readonly changed = new Set<string>();
  private toolCalls = 0;
  private readonly texts: string[] = [];
  private readonly assistantMessages = new Set<string>();
  private started = false;
  private idle = false;
  private error?: string;

  attach(sessionId: string): void {
    this.sessionId = sessionId;
  }

  on(event: unknown): void {
    if (!isRecord(event) || typeof event.type !== "string") return;

    // session-scoped events must match, otherwise a sibling worker's activity
    // lands in this worker's totals.
    //
    // opencode 2.x pushes `{ type, data: {...} }` (directory on `location`),
    // the legacy 1.x host pushed `{ type, properties: {...} }`. Support both.
    const raw = isRecord(event.properties)
      ? event.properties
      : isRecord(event.data)
        ? event.data
        : {};
    const properties = raw;

    switch (event.type) {
      case "message.updated":
        this.onMessage(properties);
        return;
      case "tool.execute.after":
        this.onTool(properties);
        return;
      case "file.edited":
        this.onFileEdit(properties);
        return;
      case "message.part.updated":
        this.onTextPart(properties);
        return;
      // opencode 1.x terminal event; 2.x splits it into succeeded/failed/interrupted.
      case "session.idle":
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        if (this.matches(properties.sessionID)) this.idle = true;
        return;
      case "session.error":
      case "session.execution.failed":
        if (this.matches(properties.sessionID)) {
          this.error = stringifyError(properties);
          this.idle = true;
        }
        return;
      default:
    }
  }

  private onMessage(properties: Record<string, unknown>): void {
    if (!isRecord(properties.info)) return;
    const info = properties.info;
    const sessionId = typeof info.sessionID === "string" ? info.sessionID : undefined;
    if (!this.matches(sessionId)) return;

    // Message ids are recorded even when usage is absent, because the text
    // filter needs to know which messages are the assistant's. Usage itself is
    // frequently zero on the live event — see the note on `usageOrZero`.
    if (typeof info.id === "string") {
      const role = info.role;
      const isAssistant =
        role === "assistant" || (isRecord(role) && role.type === "assistant");
      if (isAssistant) this.assistantMessages.add(info.id);
    }

    const usage = readUsage(info);
    if (!usage) return;

    const key = typeof info.id === "string" ? info.id : undefined;
    if (!key) return;

    // Streaming re-emits message.updated, so the ledger dedupes.
    this.ledger.record(this.sessionId ?? "session", key, usage);
    this.started = true;
  }

  private onTool(properties: Record<string, unknown>): void {
    if (!this.matches(properties.sessionID)) return;
    this.toolCalls++;
    this.started = true;
  }

  /**
   * Assistant text, accumulated per part id so a streaming update replaces its
   * own earlier value instead of appending a duplicate.
   */
  private onTextPart(properties: Record<string, unknown>): void {
    if (!this.matches(properties.sessionID)) return;

    const part = properties.part;
    if (!isRecord(part) || part.type !== "text") return;
    if (typeof part.text !== "string") return;

    // `message.part.updated` carries no role, so a user prompt arrives looking
    // exactly like an assistant reply. Without this filter the coordinator
    // returns its own prompt concatenated with the plan, which never parses.
    if (typeof part.messageID === "string" && !this.assistantMessages.has(part.messageID)) {
      return;
    }

    const key = typeof part.id === "string" ? part.id : `idx-${this.texts.length}`;
    const existing = this.texts.findIndex((_, index) => this.partKeys[index] === key);

    if (existing >= 0) this.texts[existing] = part.text;
    else {
      this.partKeys[this.texts.length] = key;
      this.texts.push(part.text);
    }
    this.started = true;
  }

  private readonly partKeys: string[] = [];

  private onFileEdit(properties: Record<string, unknown>): void {
    if (!this.matches(properties.sessionID)) return;
    const file = properties.file ?? properties.path;
    if (typeof file === "string" && file.length > 0) this.changed.add(file);
    this.started = true;
  }

  private matches(sessionId: unknown): boolean {
    return this.sessionId !== null && sessionId === this.sessionId;
  }

  snapshot(): Observation {
    return {
      sessionId: this.sessionId,
      usage: this.ledger.totalUsage(),
      toolCalls: this.toolCalls,
      texts: [...this.texts],
      changedFiles: [...this.changed],
      started: this.started,
      idle: this.idle,
      error: this.error,
    };
  }

  /**
   * WARNING: live `message.updated` events routinely carry
   * `{ input: 0, output: 0, ... }` even for a session that later records tens of
   * thousands of tokens. Verified against a live server: the session row showed
   * 34,539 input tokens while every event for it reported zero.
   *
   * So event-derived usage is **not** a cost measurement. Real totals have to be
   * read from the session database after the run — see session-db.ts, which
   * is the only accurate source found.
   */
  usageOrZero(): TokenUsage {
    return this.snapshot().usage ?? EMPTY_USAGE;
  }
}

function stringifyError(properties: Record<string, unknown>): string {
  const error = properties.error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  return "session error";
}

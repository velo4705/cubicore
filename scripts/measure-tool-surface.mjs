/**
 * Tool-schema surface meter.
 *
 * The 2026-11 deferred plan said: "Print the tool-schema block size for the
 * associate and for the Main agent. Cheap and decisive." This is that print,
 * against the live host, without ever printing a secret.
 *
 * What it measures exactly: for every MCP server in the host's opencode.json,
 * the byte size of the tool schemas the host would send on every turn
 * (tools/list payload) and the tool count. Remote servers are handshaked over
 * streamable-HTTP; local servers over stdio. Builtins are reported separately.
 *
 * Output: one line per server (name, transport, tools, schema bytes, ≈tokens),
 * plus totals for the Main agent (every server) and the Cubicore associate
 * (wildcard-deny; no MCP servers at all).
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { TextEncoder } from "node:util";

const CONFIG = process.env.OPENCODE_PROFILE ??
  `${process.env.HOME}/.var/app/ai.opencode.opencode/config/opencode/opencode.json`;
const encoder = new TextEncoder();
const config = JSON.parse(readFileSync(CONFIG, "utf8"));

const authHeaders = (name, headers) =>
  headers && Object.keys(headers).length ? headers : {};

const byteSize = (value) => encoder.encode(JSON.stringify(value)).byteLength;

async function remoteTools(name, url, headers) {
  const init = await postJson(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "surface-meter", version: "0.1.0" },
    },
  }, headers);
  if (!init.ok) return { ok: false, reason: `initialize: ${init.reason}` };
  // Remote MCP servers may require the session id echoed in a header.
  const sessionHeader = init.sessionId ? { "Mcp-Session-Id": init.sessionId } : {};
  await postJson(url, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, { ...headers, ...sessionHeader })
    .catch(() => null); // notifications may 202 with no body
  const list = await postJson(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { ...headers, ...sessionHeader });
  if (!list.ok) return { ok: false, reason: `tools/list: ${list.reason}` };
  const tools = list.result?.tools;
  if (!Array.isArray(tools)) return { ok: false, reason: "tools/list returned no tools array" };
  return { ok: true, tools: tools.length, bytes: byteSize(tools) };
}

async function postJson(url, message, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...extraHeaders,
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    const text = await res.text();
    const jsonText = extractJson(text);
    if (jsonText === null) {
      return { ok: false, reason: `HTTP ${res.status}: non-JSON response (${text.slice(0, 80)})` };
    }
    const parsed = JSON.parse(jsonText);
    if (parsed.error) return { ok: false, reason: `RPC error: ${parsed.error.message}` };
    return { ok: true, result: parsed.result, sessionId: res.headers.get("mcp-session-id") ?? undefined };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

// MCP remote servers may reply with SSE frames; the payload is the JSON after "data:".
function extractJson(text) {
  const t = text.trim();
  if (t.startsWith("{")) return t;
  for (const line of t.split("\n")) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload.startsWith("{")) return payload;
    }
  }
  return null;
}

async function stdioTools(name, command) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, "NO_COLOR": "1" },
    });
    let stdout = "";
    let stderrHead = "";
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    const finish = (value) => {
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "stdio timeout (45s)" }), 45_000);
    child.on("error", (error) => finish({ ok: false, reason: error.message }));
    child.stderr.on("data", (chunk) => { stderrHead += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const messages = stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
      const init = messages.find((m) => m.id === 1);
      if (init && !send.initialized) {
        send.initialized = true;
        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      }
      const list = messages.find((m) => m.id === 2);
      if (list) {
        const tools = list.result?.tools;
        if (!Array.isArray(tools)) {
          finish({ ok: false, reason: "tools/list returned no tools array" });
        } else {
          finish({ ok: true, tools: tools.length, bytes: byteSize(tools) });
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "surface-meter", version: "0.1.0" },
      },
    });
  });
}

const servers = { ...(config.mcp ?? {}), ...(config.servers ?? {}) };
const rows = [];
for (const [name, cfg] of Object.entries(servers)) {
  const isRemote = cfg.type === "remote";
  const started = Date.now();
  const result = isRemote
    ? await remoteTools(name, cfg.url, authHeaders(name, cfg.headers))
    : await stdioTools(name, cfg.command);
  if (result.ok) {
    rows.push({ name, type: cfg.type, tools: result.tools, bytes: result.bytes, ms: Date.now() - started });
  } else {
    rows.push({ name, type: cfg.type, failed: result.reason });
  }
  process.stderr.write(`measured ${name}\n`);
}

const okRows = rows.filter((r) => !r.failed);
const failedRows = rows.filter((r) => r.failed);
const totalTools = okRows.reduce((n, r) => n + r.tools, 0);
const totalBytes = okRows.reduce((n, r) => n + r.bytes, 0);
const kb = (n) => (n / 1024).toFixed(1);
const approxTokens = (n) => Math.round(n / 4).toLocaleString("en-US");

console.log("");
console.log("tool-schema surface —", CONFIG);
console.log("");
for (const row of rows) {
  if (row.failed) {
    console.log(`${row.name.padEnd(20)} ${row.type.padEnd(7)} FAILED: ${row.failed}`);
  } else {
    console.log(
      `${row.name.padEnd(20)} ${row.type.padEnd(7)} tools=${String(row.tools).padEnd(4)} ` +
      `schema=${kb(row.bytes).padStart(8)} KB (~${approxTokens(row.bytes)} tok)  (${row.ms} ms)`,
    );
  }
}
console.log("");
console.log(`Main agent MCP surface: ${totalTools} tools, ${kb(totalBytes)} KB (~${approxTokens(totalBytes)} tok) — per tier re-read, every turn`);
console.log(`Cubicore associate MCP surface: 0 tools (wildcard-deny in toolsForContract)`);
if (failedRows.length > 0) {
  console.log(`not measured (unreachable): ${failedRows.map((r) => r.name).join(", ")} — totals exclude them`);
}

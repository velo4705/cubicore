/**
 * Cubicore doctor — read-only diagnosis of the host and the current project.
 *
 * The checks are the ones that broke in production: credentials, port, live
 * session-create, model configuration, MCP registration, installed version,
 * and plan/run state on disk. Nothing is repaired here and no secret is ever
 * printed. A credential is reported by its source label only.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveCredential, basicAuthFor } from "./mcp/service";
import { detectHosts, renderHosts } from "./adapters/hosts";
import { runtimeFromEnv } from "./adapters/opencode/runtime";
import { resolveTargets, type InstallTarget, type ResolveOptions } from "./install/targets";
import { parseJsonc } from "./install/jsonc";

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
}

export interface DoctorOptions {
  env?: Record<string, string | undefined>;
  directory?: string;
  fetchImpl?: typeof fetch;
  resolveTargetsFn?: (options: ResolveOptions) => InstallTarget[];
}

function check(name: string, status: DoctorStatus, detail: string, hint?: string): DoctorCheck {
  return { name, status, detail, ...(hint ? { hint } : {}) };
}

function versionStamp(configFile: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(dirname(configFile), ".cubicore-version"), "utf8"));
    return typeof raw.version === "string" ? raw.version : "unknown";
  } catch {
    return "not installed here";
  }
}

function configCheck(target: InstallTarget, env: Record<string, string | undefined>, resolveTargetsFn: DoctorOptions["resolveTargetsFn"]): DoctorCheck {
  try {
    const raw = readFileSync(target.configFile, "utf8");
    const parsed = parseJsonc(raw) as { mcp?: Record<string, unknown> };
    const entry = parsed.mcp?.cubicore;
    if (!entry) {
      return check(`config: ${target.id}`, "warn", `no Cubicore MCP entry in ${target.configFile}`, "run npx cubicore@latest setup --" + target.id);
    }
    return check(`config: ${target.id}`, "ok", `registered in ${target.configFile}`, `installed version ${versionStamp(target.configFile)}`);
  } catch {
    return check(`config: ${target.id}`, "skip", "config not readable here");
  }
}

async function sessionProbe(
  baseUrl: string,
  credential: ReturnType<typeof resolveCredential>,
  directory: string,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
  if (!credential) {
    return check("live session-create", "fail", "no credential resolved", "set OPENCODE_SERVER_PASSWORD or install service.json, then restart OpenCode");
  }
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { Authorization: basicAuthFor(credential), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "cubicore doctor probe" }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (error) {
    return check("live session-create", "fail", `request failed: ${error instanceof Error ? error.message : String(error)}`, "is OpenCode running on this port?");
  }
  if (!response.ok) {
    const proxy = response.headers.get("Proxy-Authenticate");
    const hint = response.status === 407
      ? `port is a Browser Proxy, not the CLI API${proxy ? ` (${proxy})` : ""}; set OPENCODE_PORT to the CLI port`
      : response.status === 401
        ? "credential rejected; restart OpenCode or refresh service.json"
        : undefined;
    return check("live session-create", "fail", `HTTP ${response.status}`, hint);
  }
  let id: string | undefined;
  try {
    const body = await response.json() as { data?: { id?: string } };
    id = body.data?.id;
  } catch {
    // A 200 without a usable id is still a failed probe.
  }
  if (!id) return check("live session-create", "fail", "server returned no session id");
  try {
    await fetchImpl(`${baseUrl}/api/session/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: basicAuthFor(credential) },
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // The scratch session is the only write; failure to delete is reported.
    return check("live session-create", "warn", `created ${id} but could not delete the scratch session`);
  }
  return check("live session-create", "ok", "session created and scratch session deleted");
}

function diskChecks(directory: string): DoctorCheck[] {
  const plan = join(directory, "CUBICORE_PLAN.json");
  const ledger = join(directory, ".cubicore-factory-ledger.json");
  const state = join(directory, ".cubicore-state.json");
  const cycle = join(directory, ".cubicore-cycle.json");
  const archive = join(directory, ".cubicore-archive.jsonl");
  return [
    check("plan on disk", existsSync(plan) ? "ok" : "skip", existsSync(plan) ? plan : "no CUBICORE_PLAN.json here"),
    check("factory ledger", existsSync(ledger) ? "ok" : "skip", existsSync(ledger) ? ledger : "no run recorded in this directory"),
    check("host snapshot", existsSync(state) ? "ok" : "warn", existsSync(state) ? state : "no .cubicore-state.json; run /cubicore:prepare"),
    check("cycle state", existsSync(cycle) ? "ok" : "skip", existsSync(cycle) ? cycle : "no cycle state; first run"),
    check("run archive", existsSync(archive) ? "ok" : "skip", existsSync(archive) ? archive : "no archived runs in this directory"),
  ];
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const env = options.env ?? process.env;
  const directory = options.directory ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolve = options.resolveTargetsFn ?? resolveTargets;
  const checks: DoctorCheck[] = [];

  const credential = resolveCredential(env);
  checks.push(credential
    ? check("credential", "ok", `resolved from ${credential.label}`)
    : check("credential", "fail", "no credential found", "set OPENCODE_SERVER_PASSWORD or install service.json"));

  let runtime: ReturnType<typeof runtimeFromEnv>;
  try {
    runtime = runtimeFromEnv(env);
    checks.push(check("port", "ok", `${runtime.port} (${env.OPENCODE_PORT ? "explicit" : "discovered"})`, runtime.baseUrl));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push(check("port", "fail", detail.slice(0, 220), "set OPENCODE_PORT to the OpenCode CLI port"));
    checks.push(check("live session-create", "skip", "no runtime to probe"));
    checks.push(check("worker model", "warn", "unknown until port resolves"));
    return checks;
  }

  checks.push(await sessionProbe(runtime.baseUrl, credential, directory, fetchImpl));
  checks.push(check("worker model", "ok", `${runtime.models.cheap} (configured; inheritance resolves at execute time from the caller session)`));

  const resolveOpts: ResolveOptions = { platform: process.platform, env, home: env.HOME ?? process.cwd(), exists: existsSync };
  const targets = resolve(resolveOpts);
  let registered = 0;
  for (const target of targets) {
    const result = configCheck(target, env, resolve);
    if (result.status === "ok") registered++;
    checks.push(result);
  }
  if (registered === 0) {
    checks.push(check("MCP registration", "warn", "no target has a Cubicore entry", "run npx cubicore@latest setup"));
  }

  for (const line of renderHosts(detectHosts(env, directory))) {
    checks.push(check("host", line.includes("Cubicore registered") ? "ok" : line.includes("not installed") ? "skip" : "warn", line));
  }

  checks.push(...diskChecks(directory));
  return checks;
}

export function renderDoctor(checks: readonly DoctorCheck[]): string {
  const mark: Record<DoctorStatus, string> = { ok: "+", warn: "!", fail: "x", skip: "-" };
  return checks
    .map((c) => `${mark[c.status]} ${c.name}: ${c.detail}${c.hint ? `\n    ${c.hint}` : ""}`)
    .join("\n");
}

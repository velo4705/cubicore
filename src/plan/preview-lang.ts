/**
 * Language preflight for the preview.
 *
 * Preview already runs any command that starts — the limitation has nothing to
 * do with language. The gap this fills is in the failure report: when the
 * interpreter or runtime the command depends on is not on PATH, the founder
 * gets a clean sentence about *what* is missing, not a cryptic shell error.
 *
 * The map below is a best-effort heuristic across the major families of
 * executable/runtimes. It does not invent results; it reads the command the
 * plan wrote and reports on what it can see.
 */

import { spawnSync, type ChildProcess } from "node:child_process";

export interface PreflightReport {
  /** The interpreter or runtime binary the command depends on, if identifiable. */
  interpreted: string | null;
  /** True iff the binary exists on PATH. */
  available: boolean;
  /** Founder-facing detail: name missing + one sentence on the likely fix. */
  detail: string;
}

type Mapping = { pattern: RegExp; binary: string; install: string };
const MAP: Mapping[] = [
  { pattern: /^node(\s|$)/, binary: "node", install: "install Node.js (e.g. from nodejs.org, or `nix run nixpkgs#nodejs`)" },
  { pattern: /^tsx(\s|$)/, binary: "tsx", install: "install tsx (e.g. `npm install -g tsx`)" },
  { pattern: /^bun(\s|$)/, binary: "bun", install: "install Bun (e.g. from bun.sh, or `nix run nixpkgs#bun`)" },
  { pattern: /^deno(\s|$)/, binary: "deno", install: "install Deno (e.g. from deno.land, or `nix run nixpkgs#deno`)" },
  { pattern: /^python(\s|3|3\s|$)/, binary: "python3", install: "install python3 (e.g. `nix run nixpkgs#python3`)" },
  { pattern: /^ruby(\s|$)/, binary: "ruby", install: "install ruby (e.g. `nix run nixpkgs#ruby`)" },
  { pattern: /^php(\s|$)/, binary: "php", install: "install php (e.g. `nix run nixpkgs#php`)" },
  { pattern: /^java(\s|$)/, binary: "java", install: "install a JRE (e.g. `nix run nixpkgs#jre`)" },
  { pattern: /^go(\s|$)/, binary: "go", install: "install Go (e.g. `nix run nixpkgs#go`)" },
  { pattern: /^dotnet(\s|$)/, binary: "dotnet", install: "install the .NET SDK (e.g. `nix run nixpkgs#dotnet-sdk_8`)" },
  { pattern: /^mono(\s|$)/, binary: "mono", install: "install Mono (e.g. `nix run nixpkgs#mono`)" },
  { pattern: /^cargo\s+(build|run|test|exec|clippy)\b/, binary: "cargo", install: "install Rust via rustup (e.g. `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then `cargo build --release`)" },
  { pattern: /^rustc(\s|$)/, binary: "rustc", install: "install Rust via rustup (e.g. `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)" },
  { pattern: /^bun\s+run\b/, binary: "bun", install: "install Bun (e.g. from bun.sh, or `nix run nixpkgs#bun`)" },
  { pattern: /^npm\s+run\b/, binary: "npm", install: "install a JS runtime with npm — npm ships with Node.js" },
  { pattern: /^yarn\s+/, binary: "yarn", install: "install yarn (e.g. `npm install -g yarn`)" },
  { pattern: /^pnpm(\s|$)/, binary: "pnpm", install: "install pnpm (e.g. `npm install -g pnpm`)" },
  { pattern: /^pip3?(\s|$)/, binary: "pip3", install: "install Python 3 with pip (e.g. `nix run nixpkgs#python3`)" },
  { pattern: /^uv(\s|$)/, binary: "uv", install: "install uv (e.g. `nix run nixpkgs#uv`, or `curl -LsSf https://astral.sh/uv/install.sh | sh`)" },
  { pattern: /^pipx(\s|$)/, binary: "pipx", install: "install pipx (e.g. `npm i -g pipx` or your distro's package)" },
  { pattern: /^bundler\b|^bundle\s+/, binary: "bundle", install: "install bundler (e.g. `gem install bundler`)" },
  { pattern: /^mix\s+/, binary: "mix", install: "install Elixir/Erlang (e.g. `nix run nixpkgs#elixir`)" },
  { pattern: /^rebar3?\b/, binary: "rebar3", install: "install Erlang/rebar3 (e.g. `nix run nixpkgs#rebar3`)" },
  { pattern: /^zig(\s|$)/, binary: "zig", install: "install Zig (e.g. `nix run nixpkgs#zig`)" },
  { pattern: /^gcc(\s|$)/, binary: "gcc", install: "install GCC (e.g. `nix run nixpkgs#gcc`)" },
  { pattern: /^clang(\s|$)/, binary: "clang", install: "install Clang (e.g. `nix run nixpkgs#clang`)" },
  { pattern: /^make(\s|$)/, binary: "make", install: "install make (e.g. `nix run nixpkgs#gnumake`)" },
  { pattern: /^cmake(\s|$)/, binary: "cmake", install: "install cmake (e.g. `nix run nixpkgs#cmake`)" },
];

function whichish(binary: string): boolean {
  try {
    const result = spawnSync("sh", ["-c", `command -v ${shellEscape(binary)} 1>/dev/null 2>&1`], {
      timeout: 3_000,
      encoding: "utf8",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Inspect the command and report the likely runtime needed. Returns details. */
export function preflight(command: string): PreflightReport {
  const trimmed = command.trim();
  for (const { pattern, binary, install } of MAP) {
    if (pattern.test(trimmed)) {
      const available = whichish(binary);
      return {
        interpreted: binary,
        available,
        detail: available
          ? `${binary} found on PATH`
          : `${binary} not found — ${install}`,
      };
    }
  }
  return { interpreted: null, available: true, detail: "command handled natively — no interpreter preflight" };
}

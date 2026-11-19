/**
 * Failure packager — when the verifier says not all contracts hold, write a
 * terse paste-ready bundle a founder can hand to themselves (or the next
 * session). All green runs write nothing — there's nothing to triage.
 * Never replaces the debug MD; this is the short form of "what is broken".
 */
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "../contracts/types";
import type { ContractState } from "../mcp/runs";

export const TRIAGE_MD = "CUBICORE_TRIAGE.txt";

export function writeTriage(
  dir: string,
  parsed: Plan,
  verified: {
    progress: Map<string, ContractState>;
    failures: Array<{ contractId: string; checkId: string; output: string; kind: string }>;
  },
): string | null {
  const flagged = parsed.contracts.filter((c) => verified.progress.get(c.id) !== "done");
  if (flagged.length === 0) {
    try {
      if (existsSync(join(dir, TRIAGE_MD))) unlinkSync(join(dir, TRIAGE_MD));
    } catch { /* nothing recorded */
    }
    return null;
  }

  const lines: string[] = [
    `Cubicore triage — ${new Date().toISOString()}`,
    ``,
    `Project: ${(parsed.summary?.trim().split("\n")[0] ?? "(no summary)").slice(0, 120)}`,
    `Topology: ${parsed.topology} · ${parsed.contracts.length} contracts`,
    ``,
    `Failures (${flagged.length} contract${flagged.length === 1 ? "" : "s"}):`,
  ];

  for (const contract of flagged) {
    const failures = verified.failures.filter((f) => f.contractId === contract.id);
    lines.push(``);
    lines.push(`## ${contract.id}`);
    lines.push(`  writes: ${contract.writes.join(", ") || "(none)"}`);
    for (const failure of failures) {
      lines.push(`  [${failure.kind}] ${failure.checkId}`);
      lines.push(`  command output (first 10 lines):`);
      lines.push(
        failure.output
          .split("\n")
          .slice(0, 10)
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    }
    lines.push(`  next: reproduce — run the failing check exactly, fix the defect, re-run cubicore:execute.`);
  }

  lines.push(
    ``,
    `This is the short form. Full picture: CUBICORE_DEBUG.md (the narrative), .cubicore-factory-ledger.json (the audit ledger).`,
    ``,
    `.cubicore-TRIAGE.txt is overwritten on each run; save what matters before re-running.`,
  );

  try {
    writeFileSync(join(dir, TRIAGE_MD), lines.join("\n") + "\n");
    return TRIAGE_MD;
  } catch {
    return null;
  }
}

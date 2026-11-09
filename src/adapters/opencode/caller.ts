/**
 * Pick the session that an MCP-tool caller most likely belongs to.
 *
 * The MCP server has no session id in the tool-call envelope, so this is a
 * best-effort heuristic. Two failure modes are known and both bite real
 * projects:
 *
 * 1. Zombie sessions — empty probes and abandoned tabs outrank the founder's
 *    live session by creation time alone.
 * 2. Cubicore's own associates — parented to whatever was picked before, they
 *    are active and non-failed, so the naive "newest healthy" rule nests the
 *    next run under the previous run's orphaned associate instead of the
 *    founder's session. Seen live: two associates parented to a failed-run
 *    marker-b associate.
 *
 * Ranking, lower wins: a healthy founder session (1) beats a Cubicore
 * associate (10) beats anything failed or hollow (100). Ties break to the
 * newest created.
 */

export interface ListedCallerSession {
  id: string;
  title?: string | null;
  outcome?: string | null;
  cost?: number | null;
  tokens?: { input?: number | null; output?: number | null } | null;
  time?: { created?: number; updated?: number } | null;
}

function isActive(s: ListedCallerSession): boolean {
  return (
    (s.time?.updated ?? 0) > (s.time?.created ?? 0) ||
    (s.cost ?? 0) > 0 ||
    (s.tokens?.input ?? 0) > 0 ||
    (s.tokens?.output ?? 0) > 0
  );
}

function isCubicoreAssociate(s: ListedCallerSession): boolean {
  return /\(associate\)$/i.test((s.title ?? "").trim());
}

function rank(s: ListedCallerSession): number {
  if (s.outcome === "failed") return 100; // dead probe or dead run
  if (isCubicoreAssociate(s)) return 10; // cubicore's own worker, never the caller
  return 1;
}

export function pickCallerSession(sessions: readonly ListedCallerSession[]): string | undefined {
  if (sessions.length === 0) return undefined;
  const live = sessions.filter(isActive);
  const base = live.length > 0 ? live : [...sessions];
  const ranked = [...base].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return (b.time?.created ?? 0) - (a.time?.created ?? 0);
  });
  return ranked[0]?.id;
}

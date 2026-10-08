import { EMPTY_USAGE, addUsage, type TokenUsage } from "./types";

/**
 * Accumulates token usage from streaming events.
 *
 * The dedupe is load-bearing, not an optimisation. Providers re-emit
 * `message.updated` for the same message as it streams, so a naive accumulator
 * double-counts every call — and this project's headline number is a cost
 * number. Wrong totals here make the whole cost claim unfalsifiable.
 *
 * Dedupe key is `scope:key` so the same message id appearing under two workers
 * cannot silently collapse into one.
 */
export class UsageLedger {
  private readonly seen = new Set<string>();
  private readonly byScope = new Map<string, TokenUsage>();
  private total: TokenUsage = EMPTY_USAGE;
  private duplicates = 0;

  constructor(private readonly limit = 5000) {}

  /** Returns false when the key was already counted, so callers can skip. */
  record(scope: string, key: string, usage: TokenUsage): boolean {
    const dedupe = `${scope}:${key}`;
    if (this.seen.has(dedupe)) {
      this.duplicates++;
      return false;
    }
    this.seen.add(dedupe);
    this.evictIfFull();

    this.total = addUsage(this.total, usage);
    this.byScope.set(
      scope,
      addUsage(this.byScope.get(scope) ?? EMPTY_USAGE, usage),
    );
    return true;
  }

  totalUsage(): TokenUsage {
    return this.total;
  }

  forScope(scope: string): TokenUsage {
    return this.byScope.get(scope) ?? EMPTY_USAGE;
  }

  scopes(): string[] {
    return [...this.byScope.keys()];
  }

  /** How many events were discarded as repeats. Non-zero is normal. */
  duplicateCount(): number {
    return this.duplicates;
  }

  /**
   * Bounded memory. Insertion order makes the oldest keys the ones dropped,
   * which is the correct trade: a very old repeat is the cheapest to miss.
   */
  private evictIfFull(): void {
    if (this.seen.size <= this.limit) return;
    const excess = this.seen.size - this.limit;
    let dropped = 0;
    for (const key of this.seen) {
      if (dropped++ >= excess) break;
      this.seen.delete(key);
    }
  }
}
/**
 * Slow-task sentinel.
 *
 * The gate measures wall time per check. A check that only succeeds after a
 * deliberate delay exercises the timeout path: the runner must let a long
 * check finish rather than treating elapsed time as a failure.
 *
 * `sleep 25 && touch src/slow.ts` is that check. It is slow by construction
 * and must still pass, so nothing here may short-circuit it.
 */

export const SLOW_CHECK_DURATION_SECONDS = 25

export const SLOW_CHECK_COMMAND = "sleep 25 && touch src/slow.ts"

export function isSlowCheck(): boolean {
  return SLOW_CHECK_DURATION_SECONDS > 0
}

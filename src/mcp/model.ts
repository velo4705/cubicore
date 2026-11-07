/**
 * Which model the associates run on.
 *
 * The default has to be checked, not assumed. A model that no longer exists
 * fails *silently*: the session accepts the prompt, records the user message,
 * and never produces an assistant reply. There is no error anywhere. A worker
 * that way just sits there until its wall budget expires, which looks exactly
 * like a slow model and costs the whole run.
 *
 * `space-bunny-free` was removed from the provider mid-session and took every
 * dispatch with it. So the model is resolved against the provider's own list
 * at startup, and an unavailable model is a loud failure rather than a silent
 * one.
 */

// `opencode/minimax-m3.1-flash-free` was withdrawn from the provider without
// ceremony, as was space-bunny-free before it. `crouton-alpha-free` is the
// model the founder's own sessions run today, verified present in
// `opencode models` (opencode/crouton-alpha-free).
export const DEFAULT_MODEL = "opencode/crouton-alpha-free";

export interface ModelCheck {
  ok: boolean;
  model: string;
  available: string[];
  reason?: string;
}

/**
 * Resolve a model against the provider's list.
 *
 * `candidates` is tried in order, so a caller can pass a preferred model and a
 * known-good fallback.
 */
export function resolveModel(available: readonly string[], preferred?: string): ModelCheck {
  if (available.length === 0) {
    return {
      ok: false,
      model: preferred ?? DEFAULT_MODEL,
      available: [],
      reason:
        "The provider returned no models. Cannot verify which model the associates will " +
        "run on, and an unverifiable model fails silently.",
    };
  }

  const wanted = preferred ?? DEFAULT_MODEL;
  if (available.includes(wanted)) return { ok: true, model: wanted, available: [...available] };

  const fallback = available.find((m) => m.endsWith("flash-free") || m.endsWith("free"));
  if (fallback) {
    return {
      ok: true,
      model: fallback,
      available: [...available],
      reason: `Model "${wanted}" is not available; using "${fallback}" instead.`,
    };
  }

  return {
    ok: false,
    model: wanted,
    available: [...available],
    reason:
      `Model "${wanted}" is not available and no free fallback was found. ` +
      `Available: ${available.join(", ")}`,
  };
}

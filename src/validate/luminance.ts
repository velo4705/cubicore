/**
 * WCAG relative luminance and contrast, per WCAG 2.0 §1.4.3.
 *
 * The design elevation gate is heavy on honesty and light on cleverness:
 * if two colours cannot produce legible body text, the plan is rejected
 * before any worker is dispatched — not discovered by the founder later.
 *
 * This is the strongest claim a declaration can make: "this pair
 * produces a compliant ratio somewhere in the palette". It cannot
 * certify the shipped pages, which fail through other routes.
 */

function channel(i: number): number {
  const c = i / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const h = hex.replace(/^#/, "").toLowerCase();
  let r: number, g: number, b: number;
  if (h.length === 3) {
    r = channel(parseInt(h[0] + h[0], 16));
    g = channel(parseInt(h[1] + h[1], 16));
    b = channel(parseInt(h[2] + h[2], 16));
  } else if (h.length === 6) {
    r = channel(parseInt(h.slice(0, 2), 16));
    g = channel(parseInt(h.slice(2, 4), 16));
    b = channel(parseInt(h.slice(4, 6), 16));
  } else if (h.length === 8) {
    r = channel(parseInt(h.slice(0, 2), 16));
    g = channel(parseInt(h.slice(2, 4), 16));
    b = channel(parseInt(h.slice(4, 6), 16));
  } else {
    return 0;
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio in [1, 21]. Higher is better; 4.5 is the AA body-text bar. */
export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Best contrast ratio in the palette, across every pair (or 1 if <2 entries). */
export function bestPairContrast(palette: readonly string[]): number {
  let best = 1;
  for (let i = 0; i < palette.length; i += 1) {
    for (let j = i + 1; j < palette.length; j += 1) {
      const ratio = contrastRatio(palette[i] as string, palette[j] as string);
      if (ratio > best) best = ratio;
    }
  }
  return best;
}

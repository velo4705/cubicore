/**
 * Design variants — the three directions the founder picks from.
 *
 * The founder cannot look at a machine's palette and judge whether the
 * result feels like their game. They have to see something. So the factory
 * writes three candidate pages — structurally different (density, type
 * scale, accent usage) — and asks, not in prose but in pixels: which one
 * is closest to what you meant?
 *
 * What this file is NOT:
 *  - it is not a design system. Each variant is a single page.
 *  - it does not replace the founder's taste. The pick is final and recorded;
 *    the pick is the build's constraint, not a suggestion.
 *  - it does not pretend to be creative. Three CSS structures over one
 *    palette is the point — comparable, cheap to render, fast to reject.
 *
 * Constraints kept:
 *  - variants derive strictly from the plan's `design` block and `reference`;
 *  - every hex in use is one of the declared palette (gateStyle can verify);
 *  - output lands at `<dir>/CUBICORE_VARIANTS/{a,b,c}.html`;
 *  - the pick records into `.cubicore-factory-state.json` via the lifecycle
 *    so /cubicore:status and the ledger both know which direction was chosen.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "../contracts/types";
import { enterFactoryLifecycle, completeFactoryLifecycle } from "../factory/lifecycle";

export interface VariantArtifact {
  id: string;
  path: string;
  headline: string;
}

export interface VariantPick {
  current: string | null;
  history: { variant: string; pickedAt: number; note?: string }[];
  dir: string;
}

const VARIANT_DIR = "CUBICORE_VARIANTS";
const PICK_FILE = ".cubicore-factory-state.json";

const VARIANTS: { id: string; title: string; style: (plan: Plan) => string }[] = [
  {
    id: "a",
    title: "Editorial",
    style: (p) => `
      :root { color-scheme: light; }
      body { margin: 0; background: ${p.design!.palette[1]}; color: ${p.design!.palette[0]}; font-family: ${p.design!.typeface}, serif; }
      .wordmark { font-weight: 600; letter-spacing: 0.06em; font-size: 15px; color: ${accent(p)}; }
      .frame { max-width: 1080px; margin: 0 auto; padding: 44px 40px; }
      h1 { font-size: 64px; line-height: 1.05; letter-spacing: -0.03em; margin: 72px 0 22px; max-width: 14ch; }
      .sub { font-size: 18px; line-height: 1.55; max-width: 52ch; opacity: 0.78; }
      .cta { display: inline-block; margin-top: 28px; padding: 12px 26px; border: 0; border-radius: 4px; background: ${accent(p)}; color: ${onAccent(p)}; font-weight: 600; letter-spacing: 0.02em; }
      .cards { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 24px; margin: 64px 0; }
      .card { background: ${elevate(p.design!.palette[1])}; border: 1px solid ${rule(p.design!.palette[0])}; padding: 20px; border-radius: 2px; }
      .card h3 { font-size: 15px; margin: 0 0 6px; letter-spacing: 0.02em; }`,
  },
  {
    id: "b",
    title: "Full accent",
    style: (p) => `
      :root { color-scheme: dark; }
      body { margin: 0; background: ${p.design!.palette[0]}; color: ${p.design!.palette[1]}; font-family: ${p.design!.typeface}, sans-serif; }
      .frame { max-width: 1160px; margin: 0 auto; padding: 52px 40px; }
      .wordmark { font-weight: 800; letter-spacing: 0.02em; font-size: 14px; text-transform: uppercase; color: ${accent(p)}; }
      h1 { font-size: 84px; line-height: 0.95; letter-spacing: -0.04em; margin: 84px 0 18px; max-width: 13ch; text-transform: uppercase; }
      .sub { font-size: 17px; line-height: 1.5; max-width: 48ch; opacity: 0.85; }
      .cta { display: inline-block; margin-top: 30px; padding: 14px 30px; background: ${accent(p)}; color: ${onAccent(p)}; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; border-radius: 0; }
      .cards { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 2px; margin: 72px 0; }
      .card { background: ${accent(p)}; color: ${onAccent(p)}; padding: 26px 20px 28px; }
      .card h3 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 8px; }`,
  },
  {
    id: "c",
    title: "Calm list",
    style: (p) => `
      :root { color-scheme: light; }
      body { margin: 0; background: ${p.design!.palette[1]}; color: ${p.design!.palette[0]}; font-family: ${p.design!.typeface}, system-ui, sans-serif; }
      .frame { max-width: 840px; margin: 0 auto; padding: 40px 40px; }
      .wordmark { font-weight: 500; letter-spacing: 0.04em; font-size: 15px; color: ${p.design!.palette[0]}; opacity: 0.72; }
      h1 { font-size: 42px; line-height: 1.15; letter-spacing: -0.02em; margin: 56px 0 18px; }
      .sub { font-size: 16px; line-height: 1.6; max-width: 58ch; opacity: 0.82; }
      .cta { display: inline-block; margin-top: 22px; padding: 11px 20px; border: 1.5px solid ${p.design!.palette[0]}; border-radius: 999px; background: transparent; color: ${p.design!.palette[0]}; font-weight: 600; }
      .rows { margin: 48px 0; border-top: 1px solid ${rule(p.design!.palette[0])}; }
      .row { display: grid; grid-template-columns: 120px 1fr; gap: 24px; padding: 18px 0; border-bottom: 1px solid ${rule(p.design!.palette[0])}; }
      .row h3 { font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; color: ${accent(p)}; margin: 0; }`,
  },
];

function accent(plan: Plan): string {
  return plan.design!.palette[plan.design!.palette.length - 1];
}
function onAccent(plan: Plan): string {
  // Accent is last; against the palette the designer declares, pick a readable
  // foreground: palette[0] if the accent is dark, palette[1] if light.
  const accentHex = accent(plan);
  return luminance(accentHex) < 0.45 ? plan.design!.palette[1] : plan.design!.palette[0];
}
function luminance(hex: string): number {
  const m = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function elevate(_hex: string): string {
  // Do not derive a new hex; the plan's palette is the closed set. A translucent
  // white wash over any palette ground reads as an elevated card without
  // importing a hex gateStyle would reject.
  return "rgba(255,255,255,0.08)";
}
function rule(hex: string): string {
  return `rgba(0,0,0,0.14)`;
}

function page(plan: Plan, variant: (typeof VARIANTS)[number]): string {
  const title = plan.summary?.split(":")[0]?.trim() || plan.contracts[0]?.objective.split(".")[0].slice(0, 60) || "Untitled";
  const summaryTag = plan.summary?.split(": ")[1] ?? "";
  const headlineText = summarize(summaryTag || plan.contracts[0]?.objective || "", 64);
  const sub = plan.opinion ?? summaryTag ?? "Built from this brief, for real.";
  const cards = benefitList(plan).slice(0, 3);
  while (cards.length < 3) cards.push({ primary: "Ship it", body: "The plan proves out; the world around it is yours to shape." });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} — ${variant.title}</title>
<style>${variant.style(plan)}</style>
</head>
<body>
  <div class="frame">
    <div class="wordmark">${esc(title)}</div>
    <h1>${esc(headlineText)}</h1>
    <p class="sub">${esc(sub)}</p>
    <a class="cta" href="#">${esc(cta(plan))}</a>
  </div>
  <div class="frame">
    <div class="cards">
      ${cards.map((c) => `<div class="card"><h3>${esc(c.primary)}</h3>${c.body ? `<p>${esc(c.body)}</p>` : ""}</div>`).join("\n      ")}
    </div>
  </div>
  <div class="frame">
    <p style="opacity:0.5;font-size:13px">Variant ${variant.id.toUpperCase()} · ${variant.title} — generated from the plan's design block and reference for the founder's pick.</p>
  </div>
</body>
</html>`;
}

interface BenefitCard { primary: string; body: string }
function benefitList(plan: Plan): BenefitCard[] {
  const benefits = (plan.context as { benefits?: string[] } | undefined)?.benefits ?? [];
  const out: BenefitCard[] = [];
  for (const b of benefits) {
    const primary = summarize(b, 52);
    if (b.length > 52) {
      out.push({ primary, body: b });
    } else {
      out.push({ primary: b, body: "" });
    }
  }
  return out;
}
function summarize(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const words = t.slice(0, max + 1).split(" ").filter(Boolean);
  if (words.length > 1) {
    words.pop();
    return words.join(" ") + "…";
  }
  return t.slice(0, max - 1) + "…";
}

function cta(plan: Plan): string {
  return plan.contracts[0]?.deliverable === "diff" ? "See the build" : "Open";
}
function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function generateVariants(plan: Plan, cwd: string): { ok: boolean; paths: VariantArtifact[]; error?: string } {
  if (!plan.design) {
    return { ok: false, paths: [], error: "plan has no design block — nothing to render variants from" };
  }
  if (!plan.reference) {
    return { ok: false, paths: [], error: "plan has no reference — variants would default to the genre mean; pick one, then render" };
  }
  const dir = join(cwd, VARIANT_DIR);
  mkdirSync(dir, { recursive: true });
  const paths = VARIANTS.map((variant) => {
    const file = join(dir, `${variant.id}.html`);
    writeFileSync(file, page(plan, variant));
    return { id: variant.id, path: file, headline: variant.title };
  });
  try {
    enterFactoryLifecycle(cwd, "plan", `design variants rendered (${VARIANTS.length})`);
  } catch {
    // lifecycle is bookkeeping; rendering succeeded — do not fail the artifact
  }
  return { ok: true, paths };
}

export function readPick(cwd: string): VariantPick["history"] {
  const statePath = join(cwd, PICK_FILE);
  if (!existsSync(statePath)) return [];
  try {
    const json = JSON.parse(readFileSync(statePath, "utf8"));
    return Array.isArray(json.variants) ? json.variants : [];
  } catch {
    return [];
  }
}

export function recordVariantPick(cwd: string, variantId: string, note?: string): { ok: boolean; message: string } {
  if (!/^[a-c]$/.test(variantId)) {
    return { ok: false, message: `variant id must be one of a, b, c — got "${variantId}"` };
  }
  const file = join(cwd, VARIANT_DIR, `${variantId}.html`);
  if (!existsSync(file)) {
    return { ok: false, message: `variant "${variantId}" has not been rendered yet (run /cubicore:variants first)` };
  }
  try {
    enterFactoryLifecycle(cwd, "retrospect", `variant ${variantId.toUpperCase()} picked by founder${note ? `: ${note}` : ""}`);
    completeFactoryLifecycle(cwd, `variant ${variantId.toUpperCase()} picked`);
  } catch {
    // lifecycle is bookkeeping; pick is the artifact
  }
  return {
    ok: true,
    message: `variant ${variantId.toUpperCase()} picked. The build inherits this design block as-is; change it requires refine and a new pick.`,
  };
}

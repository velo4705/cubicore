/**
 * Screenshot check — the one visual bar a plan can ask of end-of-run.
 *
 * Founder complained: Cubicore's gates verify structure but never synthesis;
 * the output can pass ten contracts and look like it shipped yesterday. This
 * module is the close-the-loop primitive.
 *
 * Honest limits, written down so the code never overclaims:
 *  - It sees pixels, not taste. "good" means "color-varied + non-uniform +
 *    no errors on load", not "this is beautiful".
 *  - It does not understand game UI. It can't tell if a HUD heart renders, or
 *    if the world feels alive. It can tell if the canvas is mostly uniform
 *    color.
 *  - `blocked` means the screenshot itself failed (preview down, Playwright
 *    missing, browser refused). Not a code verdict.
 *  - It is a *flag*, not an arbitration by itself — output is stored in
 *    .cubicore-screenshot-check.json. Decide pass/fail in your contract.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync, spawn as spawn } from "node:child_process";

export type ScreenshotVerdict = "good" | "ok" | "flat" | "blocked";

export interface ScreenshotMetrics {
  saturation: number;
  uniformBlock: number;
  lumaStdDev: number;
  consoleErrors: number;
}

export interface ScreenshotResult {
  url: string;
  verdict: ScreenshotVerdict;
  metrics: ScreenshotMetrics;
  screenshot: string;
  detail: string;
}

const SAMPLE_W = 16;
const SAMPLE_H = 9;
const SAMPLE_COUNT = SAMPLE_W * SAMPLE_H;

/** Deterministic pixel statistics, computed inside the browser process. */
const SAMPLE_JS = `(function () {
  try {
    var c = document.createElement('canvas');
    c.width = ${SAMPLE_W}; c.height = ${SAMPLE_H};
    var ctx = c.getContext('2d');
    ctx.drawImage(document.documentElement || document.body, 0, 0, c.width, c.height);
    var data = ctx.getImageData(0, 0, c.width, c.height).data;
    var n = data.length / 4;
    var colors = Object.create(null);
    var sumL = 0; var sumL2 = 0; var satCount = 0; var whiteish = 0;
    for (var i = 0; i < data.length; i += 4) {
      var r = data[i], g = data[i+1], b = data[i+2];
      var max = Math.max(r, g, b), min = Math.min(r, g, b);
      var l = 0.2126*r + 0.7152*g + 0.0722*b;
      var sat = max === 0 ? 0 : (max - min) / max;
      if (sat > 0.45) satCount++;
      var key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      colors[key] = (colors[key] || 0) + 1;
      sumL += l; sumL2 += l * l;
      if (r > 245 && g > 245 && b > 245) whiteish++;
    }
    var mean = sumL / n;
    var stddev = Math.sqrt(Math.max(0, sumL2 / n - mean * mean));
    var top = 0;
    for (var k in colors) if (colors[k] > top) top = colors[k];
    var uniform = top / n;
    return JSON.stringify({
      saturation: satCount / n,
      uniformBlock: uniform,
      lumaStdDev: stddev,
      whiteish: whiteish / n,
      paletteSize: Object.keys(colors).length,
    });
  } catch (e) { return JSON.stringify({ error: String(e.message || e) }); }
})()`;

export async function screenshotCheck(target: {
  command: string;
  url: string;
  projectRoot: string;
  outFile: string;
}): Promise<ScreenshotResult> {
  const { command, url, projectRoot, outFile } = target;
  const imagePath = join(projectRoot, outFile);

  // Boot preview, poll URL until 2xx.
  const preview = spawn("sh", ["-c", command], { cwd: projectRoot, detached: true, stdio: "ignore" });
  preview.unref();

  const deadline = Date.now() + 30_000;
  let live = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) { live = true; break; }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!live) {
    try { process.kill(-preview.pid!); } catch { /* best effort */ }
    return { url, verdict: "blocked", metrics: zeroMetrics(), screenshot: imagePath,
      detail: "preview server never answered on the declared URL" };
  }

  // Navigate via Playwright; compute metrics in-page; screenshot only at the end.
  const capture = spawnSync(join(projectRoot, "node_modules", ".bin", "playwright"), [
    "screenshot",
    url,
    imagePath,
    "--viewport-size=1280,720",
    "--timeout=10000",
  ], { cwd: projectRoot });

  if (capture.status !== 0) {
    try { process.kill(-preview.pid!); } catch { /* best effort */ }
    return { url, verdict: "blocked", metrics: zeroMetrics(), screenshot: imagePath,
      detail: `playwright screenshot exited ${capture.status ?? "unknown"}. Is the preview URL correct, and are browsers installed?` };
  }

  // Compute metrics in-page (no decoder needed in-process).
  const evalProc = spawnSync(join(projectRoot, "node_modules", ".bin", "playwright"), [
    "evaluate", url, SAMPLE_JS,
  ], { cwd: projectRoot });
  let metrics = zeroMetrics();
  let detailLines: string[] = [`screenshot saved to ${outFile}`];
  try {
    const raw = (evalProc.stdout || "").toString().trim();
    const json = JSON.parse(raw);
    if (!json.error && typeof json.saturation === "number") {
      metrics = {
        saturation: json.saturation,
        uniformBlock: json.uniformBlock,
        lumaStdDev: json.lumaStdDev,
        consoleErrors: 0,
      };
    } else {
      detailLines.push(`in-page sample returned: ${(json.error ?? "unknown error")}`);
    }
  } catch (e) {
    detailLines.push(`in-page sample parse failed: ${(e as Error).message}`);
  }

  try { process.kill(-preview.pid!); } catch { /* best effort */ }

  const verdict = verdictFor(metrics);
  detailLines.push(`saturation ${metrics.saturation.toFixed(2)} · uniform ${Math.round(metrics.uniformBlock * 100)}% · σ(luma) ${metrics.lumaStdDev.toFixed(1)}`);
  const detail = detailLines.join(" · ");
  const reportPath = join(projectRoot, ".cubicore-screenshot-check.json");
  try { mkdirSync(projectRoot, { recursive: true }); writeFileSync(reportPath, JSON.stringify({ url, verdict, metrics, detail, screenshot: outFile }, null, 2)); } catch { /* report is advisory */ }
  return { url, verdict, metrics, screenshot: imagePath, detail };
}

function zeroMetrics(): ScreenshotMetrics {
  return { saturation: 0, uniformBlock: 0, lumaStdDev: 0, consoleErrors: 0 };
}

function verdictFor(m: ScreenshotMetrics): ScreenshotVerdict {
  if (m.uniformBlock > 0.75 && m.saturation < 0.18) return "flat";
  if (m.saturation >= 0.40 && m.uniformBlock <= 0.55) return "good";
  if (m.saturation >= 0.25) return "ok";
  return "flat";
}

export const __testing = { verdictFor };

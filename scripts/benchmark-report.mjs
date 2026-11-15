#!/usr/bin/env bun
/**
 * Render the benchmark evidence report from docs/benchmarks/runs.jsonl.
 *
 * The file is the source of truth: this script reads it, prints a table, and
 * writes docs/benchmarks/report.html. It never invents numbers. Unknown cells
 * render as "unknown", medians are computed only over rows that actually
 * measured a value, and a metric with fewer than 2 numeric measurements is
 * labelled inconclusive — not charted, not claimed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const JSONL = join(ROOT, "docs/benchmarks/runs.jsonl");
const OUT = join(ROOT, "docs/benchmarks/report.html");

/** @type {Array<Record<string, unknown>>} */
const rows = readFileSync(JSONL, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const COLUMNS = [
  ["project", "project"],
  ["arm", "arm"],
  ["run", "run"],
  ["contracts", "contracts"],
  ["durationMs", "duration (ms)"],
  ["tokens", "tokens"],
  ["buildGreen", "build"],
  ["playwright", "smoke"],
  ["visualVerdict", "visual"],
  ["accepted", "ok"],
  ["failed", "failed"],
  ["deferred", "deferred"],
  ["escapes", "escapes"],
  ["interventions", "human fixes"],
];

const isUnknown = (v) => v === null || v === undefined || v === "";
const cell = (v) => (isUnknown(v) ? "unknown" : String(v));

function median(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

const numericColumns = COLUMNS.map(([key]) => key).filter((key) =>
  key !== "project" && key !== "arm",
);

const medians = {};
for (const key of numericColumns) {
  medians[key] = median(rows.map((r) => r[key]));
}

const escapes = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const table = `<table>
<thead><tr>${COLUMNS.map(([, label]) => `<th>${escapes(label)}</th>`).join("")}<th>note</th></tr></thead>
<tbody>
${rows.map((row) => `<tr>${COLUMNS.map(([key]) => `<td>${escapes(cell(row[key]))}</td>`).join("")}<td class="note">${escapes(String(row.note ?? "").slice(0, 400))}</td></tr>`).join("\n")}
</tbody>
</table>`;

const medianTable = `<table>
<thead><tr><th>metric</th><th>median</th><th>n measured</th><th>inconclusive?</th></tr></thead>
<tbody>
${numericColumns.map((key) => {
  const measured = rows.filter((r) => typeof r[key] === "number" && Number.isFinite(r[key])).length;
  const med = medians[key];
  return `<tr><td>${escapes(key)}</td><td>${med === null ? "unknown" : med}</td><td>${measured}</td><td>${measured < 2 ? "yes — no claim" : "no"}</td></tr>`;
}).join("\n")}
</tbody>
</table>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cubicore benchmark evidence — ${new Date().toISOString().slice(0, 10)}</title>
<style>
  body { font-family: ui-monospace, Menlo, monospace; background: #0c0c0c; color: #d8d8d8; padding: 2rem; }
  h1, h2 { color: #fff; font-weight: 600; }
  table { border-collapse: collapse; margin-bottom: 2rem; font-size: 13px; }
  th, td { border: 1px solid #333; padding: 4px 10px; text-align: left; }
  th { background: #1b1b1b; }
  td.note { max-width: 480px; font-size: 11px; color: #999; }
  .banner { border: 1px solid #5b4b1f; background: #241f0c; color: #e8d28a; padding: 0.75rem 1rem; margin-bottom: 1.5rem; }
  small { color: #777; }
</style>
</head>
<body>
<h1>Cubicore — benchmark evidence</h1>
<div class="banner">
  Generated from <code>docs/benchmarks/runs.jsonl</code> on ${new Date().toISOString()}.
  ${rows.length} run(s). Any cell reading "unknown" is an <em>unmeasured value, not a zero</em>.
  Seed rows (source: "seed") are backfilled imports — they are not comparative evidence
  and must never appear in a product claim.
</div>

<h2>Runs</h2>
${table}

<h2>Medians (over measured rows only)</h2>
${medianTable}

<small>Every cell traces to a line in runs.jsonl. Unknowns stay unknown. If a metric says
"inconclusive", no claim should be published for it — measure or omit.</small>
</body>
</html>`;

writeFileSync(OUT, html);
console.log(`report written to ${OUT}`);
console.log(`runs: ${rows.length} · measured durationMs: ${rows.filter((r) => typeof r.durationMs === "number").length} · measured tokens: ${rows.filter((r) => typeof r.tokens === "number").length}`);

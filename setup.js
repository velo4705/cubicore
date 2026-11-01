#!/usr/bin/env node
const { writeFileSync, existsSync, readFileSync, mkdirSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");

function writeConfig(path, entry) {
  let cfg = { servers: {}, enabled: true };
  try {
    if (existsSync(path)) cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  cfg.servers = cfg.servers || {};
  cfg.servers.cubicore = entry;
  if (cfg.enabled === undefined) cfg.enabled = true;
  const dir = require("path").dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  console.log("Wrote", path);
}

writeConfig(join(homedir(), ".config/opencode/opencode.json"), {
  command: "node",
  args: ["dist/mcp-main.js"],
  enabled: true
});

writeConfig(join(homedir(), ".var/app/ai.opencode.opencode/config/opencode/opencode.json"), {
  command: "node",
  args: ["dist/mcp-main.js"],
  enabled: true,
  filesystem: ["~/Projects/cubicore"]
});

console.log("Cubicore installed to opencode configs (host + Flatpak). Restart OpenCode fully.");

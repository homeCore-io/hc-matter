#!/usr/bin/env node
// hc-matter: homeCore starts it as `node out/main.js <config.toml>`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { MatterPlugin } from "./plugin.js";

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: hc-matter <config.toml>");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version: string };

let config;
try {
  config = loadConfig(configPath);
} catch (e) {
  console.error(`hc-matter: ${configPath}: ${(e as Error).message}`);
  process.exit(1);
}

new MatterPlugin(config, pkg.version).start();

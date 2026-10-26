#!/usr/bin/env node
// Syntax-check every source file in one Node process. Running the `node --check`
// chain through npm's Windows shim can leave npm waiting on orphaned shell
// handles, so this script owns the child processes explicitly.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [
  "config.js",
  "logger.js",
  "index.js",
  "tools/evil-panda.js",
  "tools/uniswap-v3.js",
  "tools/position-key.js",
  "tools/discovery.js",
  "tools/html.js",
  "tools/pool-analysis.js",
  "tools/telegram-commands.js",
  "tools/deploy.js",
  "tools/position-manager.js",
];

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    console.error(`${file}: ${result.error.message}`);
    failed = true;
  } else if (result.status !== 0) {
    console.error(`${file}: syntax check failed`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`Syntax OK (${files.length} files).`);

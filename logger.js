// ─── Local logger (isolated from the Solana bot) ────────────────────
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

/**
 * Log a categorized line to stdout and to logs/agent-YYYY-MM-DD.log.
 * Category naming follows the Solana bot: include "warn"/"error" to set level,
 * e.g. log("panda_warn", "...") or log("startup_error", "...").
 */
export function log(category, message) {
  const level = String(category).includes("error") ? "error"
    : String(category).includes("warn") ? "warn"
    : "info";
  if (LEVELS[level] < LEVEL) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${String(category).toUpperCase()}] ${message}`;
  console.log(line);

  try {
    const dateStr = timestamp.split("T")[0];
    fs.appendFileSync(path.join(LOG_DIR, `agent-${dateStr}.log`), line + "\n");
  } catch {
    // Logging must never take the bot down.
  }
}

export default { log };

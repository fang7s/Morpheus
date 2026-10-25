// ─── Telegram command menu for Morpheus EVM ──────────────────────────
// Read-only status commands plus a native long-polling listener. Commands are
// restricted to TELEGRAM_CHAT_ID and never affect the indicator/exit loop.

import { Wallet, formatEther } from "ethers";
import { chainInfo } from "../config.js";
import { log } from "../logger.js";
import { positionKey } from "./position-key.js";

const MAX_MESSAGE_LENGTH = 3_900;
const DEFAULT_HISTORY_LIMIT = 10;
const RPC_STATUS_TIMEOUT_MS = 8_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortAddress(value) {
  const address = String(value || "");
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatUsd(value) {
  const number = finiteNumber(value);
  return number == null ? "n/a" : `$${number.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatSignedUsd(value) {
  const number = finiteNumber(value);
  if (number == null) return "n/a";
  return `${number >= 0 ? "+" : "-"}${formatUsd(Math.abs(number))}`;
}

function formatPct(value) {
  const number = finiteNumber(value);
  return number == null ? "n/a" : `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatNative(wei) {
  try {
    const [whole, fraction = ""] = formatEther(wei).split(".");
    return `${whole}.${(fraction + "000000").slice(0, 6)}`;
  } catch {
    return "n/a";
  }
}

function pairName(position) {
  const state = position.state || {};
  const token0 = state.token0Symbol || shortAddress(position.token0);
  const token1 = state.token1Symbol || shortAddress(position.token1);
  return `${token0 || "?"}/${token1 || "?"}`;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function parseTelegramCommand(text) {
  const token = String(text || "").trim().split(/\s+/)[0] || "";
  if (!token.startsWith("/")) return null;
  const command = token.slice(1).split("@")[0].toLowerCase();
  return command || null;
}

/** Exact chat-ID allow-list check. An empty allow-list rejects everyone. */
export function isAuthorizedChat(chatId, allowedChatId) {
  const allowed = String(allowedChatId ?? "").trim();
  if (!allowed) return false;
  return String(chatId ?? "") === allowed;
}

/** Split long replies below Telegram's 4096-character message limit. */
export function chunkMessage(text, maxLength = MAX_MESSAGE_LENGTH) {
  const value = String(text ?? "");
  if (value.length <= maxLength) return [value];

  const chunks = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength / 2)) cut = maxLength;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Address from the configured key, or the watch-only discovery wallet. */
export function walletAddress(config) {
  if (config?.privateKey) {
    try {
      return new Wallet(config.privateKey).address;
    } catch {
      // Invalid key: fall through to the discovery wallet.
    }
  }
  return config?.discovery?.wallet || null;
}

export function formatHelp(config, runtime = {}) {
  const startedAtMs = finiteNumber(runtime.startedAtMs);
  const uptimeSec = startedAtMs == null
    ? 0
    : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1_000));
  const hours = Math.floor(uptimeSec / 3_600);
  const minutes = Math.floor((uptimeSec % 3_600) / 60);

  return [
    "Morpheus EVM LP Agent",
    `Status: ${config.dryRun ? "SHADOW / DRY-RUN" : "LIVE"} | Chain: ${config.chain} (${config.chainId})`,
    `Uptime: ${hours}h ${minutes}m | Polls: ${runtime.polls || 0} | Errors: ${runtime.errors || 0}`,
    "",
    "Commands:",
    "/start or /help — this menu and bot status",
    "/wallet — wallet address, native balance, RPC status",
    "/positions — open LP positions",
    "/history — last 10 closed positions",
    "/pnl — realized PnL estimate",
    "",
    "Entry prices are first-observed prices. PnL is an estimate only.",
  ].join("\n");
}

export function formatPositions(positions = [], runtime = {}) {
  const tracked = runtime.tracked instanceof Map ? runtime.tracked : new Map();
  const open = positions.filter((position) => !tracked.get(positionKey(position))?.exited);
  if (open.length === 0) return "No open LP positions.";

  const lines = [`Open LP positions (${open.length})`];
  open.forEach((position, index) => {
    const state = tracked.get(positionKey(position)) || {};
    const entryPrice = finiteNumber(state.entryPrice);
    const activePrice = finiteNumber(state.last?.price);
    const deltaPct = entryPrice && activePrice
      ? ((activePrice / entryPrice) - 1) * 100
      : null;
    const ticks = position.onchain
      && finiteNumber(position.onchain.tickLower) != null
      && finiteNumber(position.onchain.tickUpper) != null
      ? ` | ticks ${position.onchain.tickLower} → ${position.onchain.tickUpper}`
      : "";

    lines.push(`${index + 1}. ${pairName(position)} [${position.chain || "?"}]`);
    lines.push(
      `   pool ${shortAddress(position.pool)} | fee ${position.fee ?? "?"}${ticks}`
      + `${position.tokenId ? ` | tokenId ${position.tokenId}` : ""}`,
    );
    lines.push(
      `   entry ${formatUsd(entryPrice)} | active ${formatUsd(activePrice)} | `
      + `delta ${formatPct(deltaPct)}${state.last?.source ? ` (${state.last.source})` : ""}`,
    );
  });
  return lines.join("\n");
}

export function formatHistory(runtime = {}, limit = DEFAULT_HISTORY_LIMIT) {
  const exits = Array.isArray(runtime.exits) ? runtime.exits : [];
  const recent = exits.slice(-Math.max(1, limit)).reverse();
  if (recent.length === 0) return "No closed LP positions yet (history is in-memory since restart).";

  const lines = [`Closed LP positions (last ${recent.length})`];
  recent.forEach((exit, index) => {
    const pnl = finiteNumber(exit.pnlUsd);
    lines.push(`${index + 1}. ${exit.label || exit.pair || "position"} [${exit.chain || "?"}]`);
    lines.push(`   ${exit.at || "unknown time"} | reason: ${exit.reason || "n/a"}`);
    lines.push(
      `   exit ${formatUsd(exit.exitPrice ?? exit.price)}`
      + `${exit.shadow ? " | shadow" : " | live"}`
      + `${pnl == null ? "" : ` | PnL ${formatSignedUsd(pnl)}`}`,
    );
  });
  return lines.join("\n");
}

export function formatPnl(runtime = {}) {
  const exits = Array.isArray(runtime.exits) ? runtime.exits : [];
  const estimated = exits.filter((exit) => finiteNumber(exit.pnlUsd) != null);
  const total = estimated.reduce((sum, exit) => sum + finiteNumber(exit.pnlUsd), 0);
  const wins = estimated.filter((exit) => finiteNumber(exit.pnlUsd) > 0).length;
  const losses = estimated.filter((exit) => finiteNumber(exit.pnlUsd) < 0).length;
  const unestimated = exits.length - estimated.length;

  return [
    "Realized PnL (estimate)",
    `Closed trades: ${exits.length}`,
    `Estimated PnL: ${estimated.length ? formatSignedUsd(total) : "n/a"}`,
    `Wins: ${wins} | Losses: ${losses} | Unestimated: ${unestimated}`,
    "",
    "Estimate uses amountUsd and the base-token entry/exit prices;",
    "it does not include fees, slippage, or impermanent loss.",
  ].join("\n");
}

async function readChainStatus(config, router, chainKey, address) {
  const chain = chainInfo(chainKey);
  try {
    const client = router.get(chainKey);
    const blockNumber = await withTimeout(
      client.provider.getBlockNumber(),
      RPC_STATUS_TIMEOUT_MS,
      `${chainKey} block`,
    );
    const balance = address
      ? await withTimeout(
        client.provider.getBalance(address),
        RPC_STATUS_TIMEOUT_MS,
        `${chainKey} balance`,
      )
      : null;
    const native = chain.nativeSymbol || "ETH";
    return `${chain.name}: OK (block ${blockNumber}) | ${balance == null ? "n/a" : formatNative(balance)} ${native}`;
  } catch (error) {
    return `${chain.name}: FAILED (${error.shortMessage || error.message})`;
  }
}

export async function formatWallet({ config, router }) {
  const address = walletAddress(config);
  const chainKeys = Object.keys(config.rpcByChain || {});
  if (chainKeys.length === 0 && config.chain) chainKeys.push(config.chain);

  const lines = [
    "Wallet",
    `Address: ${address || "not configured"}`,
    `Mode: ${config.dryRun ? "SHADOW / DRY-RUN" : "LIVE"}`,
    "",
    "Connections:",
  ];

  const statuses = await Promise.all(
    chainKeys.map((chainKey) => readChainStatus(config, router, chainKey, address)),
  );
  lines.push(...statuses);
  return lines.join("\n");
}

export async function handleTelegramCommand(command, ctx) {
  switch (command) {
    case "start":
    case "help":
      return formatHelp(ctx.config, ctx.runtime);
    case "wallet":
      return formatWallet(ctx);
    case "positions":
      return formatPositions(ctx.positions, ctx.runtime);
    case "history":
      return formatHistory(ctx.runtime);
    case "pnl":
      return formatPnl(ctx.runtime);
    default:
      return `Unknown command: /${command}\n\n${formatHelp(ctx.config, ctx.runtime)}`;
  }
}

export async function sendTelegramMessage(config, text, fetchImpl = globalThis.fetch) {
  const token = config?.telegram?.botToken;
  const chatId = config?.telegram?.chatId;
  if (!token || !chatId) throw new Error("Telegram bot token/chat ID is not configured");

  for (const chunk of chunkMessage(text)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.description || `Telegram HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Exit alerts remain gated by TELEGRAM_ENABLED; commands do not use this. */
export async function notifyTelegram(config, text, fetchImpl = globalThis.fetch) {
  if (!config?.telegram?.enabled) return;
  try {
    await sendTelegramMessage(config, text, fetchImpl);
  } catch (error) {
    log("panda_warn", `Telegram alert failed: ${error.message}`);
  }
}

/**
 * Start non-blocking getUpdates long-polling. Returns null when commands are
 * disabled or credentials are missing. Call `stop()` during shutdown.
 */
export function startTelegramCommandPoller(ctx, options = {}) {
  const telegram = ctx?.config?.telegram || {};
  if (telegram.commandsEnabled === false || !telegram.botToken || !telegram.chatId) {
    return null;
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const send = options.send || ((text) => sendTelegramMessage(ctx.config, text, fetchImpl));
  const timeoutSec = options.timeoutSec ?? 25;
  const retryDelayMs = options.retryDelayMs ?? 3_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const apiBase = `https://api.telegram.org/bot${telegram.botToken}`;

  let stopped = false;
  let offset = 0;
  let controller = null;
  let unauthorizedWarned = false;

  const done = (async () => {
    log("telegram", `Command menu listening for chat ${telegram.chatId}`);
    while (!stopped) {
      controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), (timeoutSec + 10) * 1_000);
      try {
        const params = new URLSearchParams({
          timeout: String(timeoutSec),
          allowed_updates: JSON.stringify(["message"]),
        });
        if (offset) params.set("offset", String(offset));

        const response = await fetchImpl(`${apiBase}/getUpdates?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
        const payload = await response.json();
        if (!payload?.ok) throw new Error(payload?.description || "Telegram getUpdates failed");

        const updates = Array.isArray(payload.result) ? payload.result : [];
        for (const update of updates) {
          if (stopped) break;
          if (update.update_id != null) offset = Number(update.update_id) + 1;

          const message = update.message || update.edited_message;
          if (!message?.text) continue;
          const chatId = message.chat?.id;
          if (!isAuthorizedChat(chatId, telegram.chatId)) {
            if (!unauthorizedWarned) {
              unauthorizedWarned = true;
              log("telegram_warn", `Ignored command from unauthorized chat ${chatId}`);
            }
            continue;
          }

          const command = parseTelegramCommand(message.text);
          if (!command) continue;
          try {
            const reply = await handleTelegramCommand(command, ctx);
            await send(reply);
          } catch (error) {
            log("telegram_warn", `Command /${command} failed: ${error.message}`);
            await send(`Command failed: ${error.message}`).catch(() => {});
          }
        }

        if (updates.length === 0 && pollIntervalMs > 0) await delay(pollIntervalMs);
      } catch (error) {
        if (stopped || error.name === "AbortError") break;
        log("telegram_warn", `Telegram polling error: ${error.message}`);
        await delay(retryDelayMs);
      } finally {
        clearTimeout(timer);
      }
    }
  })();
  done.catch(() => {});

  return {
    stop() {
      stopped = true;
      try {
        controller?.abort();
      } catch {
        // Controller may already be aborted.
      }
    },
    get stopped() {
      return stopped;
    },
    done,
  };
}




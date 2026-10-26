// ─── Post-deployment LP automation & position management ──────────────
// Persists per-position automation settings in active-automations.json and
// renders the Telegram management menu. The monitoring loop calls
// `monitorAutomations(ctx)` once per cycle.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";
import { escapeHtml } from "./html.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AUTOMATIONS_FILE = path.join(__dirname, "..", "active-automations.json");
export const ALERT_INTERVALS = [5, 15, 30, 0];
export const TP_PRESETS = [5, 10, 25, 50];
export const SL_PRESETS = [5, 10, 25, 50];

function emptyStore() {
  return { version: 1, updatedAt: null, automations: {} };
}

function normalizeStore(value) {
  if (!value || typeof value !== "object") return emptyStore();
  const automations = value.automations && typeof value.automations === "object"
    ? value.automations
    : {};
  return {
    version: 1,
    updatedAt: value.updatedAt || null,
    automations,
  };
}

/** Read the automation store. A missing/corrupt file degrades to an empty store. */
export function loadAutomations(filePath = AUTOMATIONS_FILE) {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log("panda_warn", `Failed to read ${filePath}: ${error.message}`);
    }
    return emptyStore();
  }
}

/** Persist the automation store atomically (tmp file + rename). */
export function saveAutomations(store, filePath = AUTOMATIONS_FILE) {
  const value = normalizeStore(store);
  value.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  return value;
}

export function listAutomations({ filePath = AUTOMATIONS_FILE, status = null } = {}) {
  const store = loadAutomations(filePath);
  const values = Object.values(store.automations);
  return status ? values.filter((entry) => entry.status === status) : values;
}

export function getAutomation(id, { filePath = AUTOMATIONS_FILE } = {}) {
  return loadAutomations(filePath).automations[String(id)] || null;
}

export function upsertAutomation(automation, { filePath = AUTOMATIONS_FILE } = {}) {
  if (!automation?.id) throw new Error("upsertAutomation requires an id");
  const store = loadAutomations(filePath);
  store.automations[String(automation.id)] = {
    ...(store.automations[String(automation.id)] || {}),
    ...automation,
    updatedAt: new Date().toISOString(),
  };
  saveAutomations(store, filePath);
  return store.automations[String(automation.id)];
}

export function updateAutomation(id, patch, { filePath = AUTOMATIONS_FILE } = {}) {
  const store = loadAutomations(filePath);
  const key = String(id);
  if (!store.automations[key]) return null;
  store.automations[key] = {
    ...store.automations[key],
    ...patch,
    id: key,
    updatedAt: new Date().toISOString(),
  };
  saveAutomations(store, filePath);
  return store.automations[key];
}

/** Mark any open automation for an NFT as closed (used by Evil Panda exits). */
export function closeAutomationByTokenId(tokenId, patch = {}, { filePath = AUTOMATIONS_FILE } = {}) {
  const store = loadAutomations(filePath);
  let changed = false;
  for (const automation of Object.values(store.automations)) {
    if (String(automation.tokenId) !== String(tokenId) || automation.status === "closed") continue;
    Object.assign(automation, {
      status: "closed",
      closedAt: new Date().toISOString(),
      closeReason: patch.closeReason || "EVIL_PANDA",
      ...patch,
    });
    changed = true;
  }
  if (changed) saveAutomations(store, filePath);
  return changed;
}

export function automationFilePath(config) {
  return config?.deploy?.automationsPath || AUTOMATIONS_FILE;
}

function pctText(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "Off";
  return `${number > 0 ? "+" : ""}${number.toFixed(1)}%`;
}

function priceText(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "n/a";
  if (number >= 1_000) return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (number >= 1) return number.toPrecision(6);
  return number.toPrecision(5);
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

export function formatManagementCard(automation = {}) {
  const pair = `${automation.baseSymbol || automation.token0Symbol || "?"}/`
    + `${automation.quoteSymbol || automation.token1Symbol || "?"}`;
  const alert = automation.alertIntervalMin
    ? `${automation.alertIntervalMin}m`
    : "Off";
  const status = automation.status === "closed" ? "CLOSED" : "OPEN";
  const lines = [
    `<b>Position management — ${escapeHtml(pair)}</b>`,
    `Chain: ${escapeHtml(automation.chain || "?")} | `
    + `${automation.shadow ? "SHADOW position" : `NFT <code>${escapeHtml(shortId(automation.tokenId))}</code>`}`,
    `Pool: <code>${escapeHtml(shortId(automation.pool))}</code> | status: <b>${status}</b>`,
    `Range: ${automation.tickLower ?? "?"} → ${automation.tickUpper ?? "?"} ticks `
    + `(${priceText(automation.priceLower)} → ${priceText(automation.priceUpper)} quote/base)`,
    `Deposit: ${automation.baseAmount ?? 0} ${escapeHtml(automation.baseSymbol || "base")}`
    + ` + ${automation.quoteAmount ?? 0} ${escapeHtml(automation.quoteSymbol || "quote")}`
    + ` ($${Number(automation.amountUsd || 0).toFixed(2)})`,
    "",
    `<b>Alert interval:</b> ${alert}`,
    `<b>Take profit:</b> ${pctText(automation.takeProfitPct)}`,
    `<b>Stop loss:</b> ${pctText(automation.stopLossPct)}`,
    `<b>Auto-close out-of-range:</b> ${automation.autoCloseOutOfRange ? "ON" : "OFF"}`,
  ];
  if (automation.closeReason) {
    lines.push(`<b>Close reason:</b> ${escapeHtml(automation.closeReason)}`);
  }
  if (automation.closeTxHashes?.length) {
    lines.push(`<b>Close tx:</b> <code>${escapeHtml(automation.closeTxHashes.join(", "))}</code>`);
  }
  lines.push("", "<i>Settings are enforced by Morpheus's monitoring loop.</i>");
  return lines.join("\n");
}

function alertButton(interval, id, current) {
  const label = interval === 0 ? "Off" : `${interval}m`;
  return {
    text: `${Number(current) === interval ? "✓ " : ""}${label}`,
    callback_data: `mgr:a:${interval}:${id}`,
  };
}

/** Inline keyboard for a live automation. Closed positions keep no buttons. */
export function managementKeyboard(automation = {}) {
  if (automation.status === "closed") return null;
  const id = automation.id;
  return {
    inline_keyboard: [
      [
        alertButton(5, id, automation.alertIntervalMin),
        alertButton(15, id, automation.alertIntervalMin),
        alertButton(30, id, automation.alertIntervalMin),
        alertButton(0, id, automation.alertIntervalMin),
      ],
      [
        { text: "Set Take Profit %", callback_data: `mgr:t:${id}` },
        { text: "Set Stop Loss %", callback_data: `mgr:l:${id}` },
      ],
      [
        {
          text: `Auto-Close OOR: ${automation.autoCloseOutOfRange ? "ON" : "OFF"}`,
          callback_data: `mgr:o:${id}`,
        },
      ],
      [{ text: "Close Position Now", callback_data: `mgr:x:${id}` }],
    ],
  };
}

function presetKeyboard(prefix, presets, id) {
  const buttons = presets.map((value) => ({
    text: `${value}%`,
    callback_data: `mgr:${prefix}:${value}:${id}`,
  }));
  return {
    inline_keyboard: [
      buttons,
      [
        { text: "Turn Off", callback_data: `mgr:${prefix}:0:${id}` },
        { text: "Back", callback_data: `mgr:b:${id}` },
      ],
    ],
  };
}

function expiredReply() {
  return {
    text: "This position menu is no longer active. Use /positions to inspect open positions.",
    replyMarkup: null,
    answer: "Menu expired",
  };
}


async function executeClose(ctx, automation, reason = "MANUAL") {
  const config = ctx.config;
  const id = automation.id;
  const numericTokenId = /^\d+$/.test(String(automation.tokenId || ""));
  const canCloseOnChain = !config?.dryRun && !automation.shadow && numericTokenId;

  // Never mark a real on-chain position as closed while the bot is in shadow
  // mode: that would silently disable its automation without a transaction.
  if (!canCloseOnChain && !automation.shadow && numericTokenId) {
    log("panda_warn", `Close for ${id} skipped: dry-run/shadow mode is ON`);
    return { ...automation, simulatedClose: true };
  }

  let result = { shadow: true, txHashes: [] };
  if (canCloseOnChain) {
    if (!ctx.router) throw new Error("No chain router available");
    const client = ctx.router.get(automation.chain);
    result = await client.closePosition(automation.tokenId, config.exit || {});
  }

  const updated = updateAutomation(id, {
    status: "closed",
    closedAt: new Date().toISOString(),
    closeReason: reason,
    closeTxHashes: result.txHashes || [],
  }, { filePath: automationFilePath(config) });

  log(
    "panda",
    `Position automation ${id} closed (${reason})`
    + `${result.shadow ? " in shadow mode" : ` tx=${(result.txHashes || []).join(",")}`}`,
  );
  return updated || automation;
}

/**
 * Handle an inline callback beginning with `mgr:`.
 * Returns `{ text, replyMarkup, edit?, answer? }` for the Telegram poller.
 */
export async function handleManagementCallback(ctx, data, callbackQuery = {}) {
  const parts = String(data || "").split(":");
  const action = parts[1];
  const config = ctx?.config;
  const filePath = automationFilePath(config);
  const id = parts[parts.length - 1];
  const value = parts.length > 3 ? parts[2] : null;

  const automation = getAutomation(id, { filePath });
  if (!automation) return expiredReply();

  if (action === "a") {
    const interval = ALERT_INTERVALS.includes(Number(value)) ? Number(value) : 0;
    const updated = updateAutomation(id, { alertIntervalMin: interval }, { filePath });
    return {
      text: formatManagementCard(updated),
      replyMarkup: managementKeyboard(updated),
      edit: true,
      answer: interval ? `Alerts every ${interval}m` : "Alerts off",
    };
  }

  if (action === "t" || action === "l") {
    const isTp = action === "t";
    return {
      text: `<b>${isTp ? "Take profit" : "Stop loss"} for `
        + `${escapeHtml(automation.baseSymbol || "position")}</b>\n`
        + "Choose a trigger percentage based on price movement from the deployment entry.",
      replyMarkup: presetKeyboard(isTp ? "T" : "L", isTp ? TP_PRESETS : SL_PRESETS, id),
      edit: true,
      answer: isTp ? "Choose take profit" : "Choose stop loss",
    };
  }

  if (action === "T" || action === "L") {
    const isTp = action === "T";
    const pct = Number(value);
    const patch = isTp
      ? { takeProfitPct: Number.isFinite(pct) && pct > 0 ? Math.abs(pct) : null }
      : { stopLossPct: Number.isFinite(pct) && pct > 0 ? -Math.abs(pct) : null };
    const updated = updateAutomation(id, patch, { filePath });
    return {
      text: formatManagementCard(updated),
      replyMarkup: managementKeyboard(updated),
      edit: true,
      answer: isTp ? "Take profit updated" : "Stop loss updated",
    };
  }

  if (action === "o") {
    const updated = updateAutomation(id, {
      autoCloseOutOfRange: !automation.autoCloseOutOfRange,
    }, { filePath });
    return {
      text: formatManagementCard(updated),
      replyMarkup: managementKeyboard(updated),
      edit: true,
      answer: `Auto-close OOR ${updated.autoCloseOutOfRange ? "ON" : "OFF"}`,
    };
  }

  if (action === "b") {
    return {
      text: formatManagementCard(automation),
      replyMarkup: managementKeyboard(automation),
      edit: true,
      answer: "Back",
    };
  }

  if (action === "x") {
    return {
      text: `<b>Close position now?</b>\n`
        + `${escapeHtml(automation.baseSymbol || "?")}/`
        + `${escapeHtml(automation.quoteSymbol || "?")} `
        + `${automation.shadow ? "(shadow)" : `NFT ${escapeHtml(automation.tokenId)}`}\n\n`
        + "This removes all liquidity, collects principal + fees and burns the NFT.",
      replyMarkup: {
        inline_keyboard: [[
          { text: "Yes, close now", callback_data: `mgr:X:${id}` },
          { text: "Cancel", callback_data: `mgr:b:${id}` },
        ]],
      },
      edit: true,
      answer: "Confirm close",
    };
  }

  if (action === "X") {
    if (automation.status === "closed") {
      return {
        text: formatManagementCard(automation),
        replyMarkup: null,
        edit: true,
        answer: "Already closed",
      };
    }
    try {
      const updated = await executeClose(ctx, automation, "MANUAL");
      if (updated.simulatedClose) {
        return {
          text: "<b>DRY-RUN: close simulated.</b>\n"
            + "The position remains open in active-automations.json because no "
            + "transaction can be broadcast in shadow mode.\n\n"
            + formatManagementCard(updated),
          replyMarkup: managementKeyboard(updated),
          edit: true,
          answer: "Dry-run: close simulated",
        };
      }
      return {
        text: formatManagementCard(updated),
        replyMarkup: null,
        edit: true,
        answer: updated.shadow ? "Shadow close simulated" : "Position closed",
      };
    } catch (error) {
      return {
        text: `<b>Close failed</b>\n<code>${escapeHtml(error?.message || String(error))}</code>`,
        replyMarkup: managementKeyboard(automation),
        edit: true,
        answer: "Close failed",
      };
    }
  }

  return expiredReply();
}


/**
 * Pure automation evaluation used by the monitoring loop.
 * `snapshot.currentPrice` is quote-per-base and `snapshot.inRange` is on-chain.
 */
export function evaluateAutomation({
  automation = {},
  snapshot = {},
  now = Date.now(),
} = {}) {
  const entryPrice = Number(automation.entryPrice);
  const currentPrice = Number(snapshot.currentPrice);
  const pnlPct = entryPrice > 0 && currentPrice > 0
    ? ((currentPrice / entryPrice) - 1) * 100
    : null;

  let close = null;
  const takeProfit = Number(automation.takeProfitPct);
  const stopLoss = Number(automation.stopLossPct);
  if (pnlPct != null && Number.isFinite(takeProfit) && takeProfit > 0
    && pnlPct >= takeProfit) {
    close = { reason: "TAKE_PROFIT", pnlPct };
  } else if (pnlPct != null && Number.isFinite(stopLoss) && stopLoss < 0
    && pnlPct <= stopLoss) {
    close = { reason: "STOP_LOSS", pnlPct };
  } else if (automation.autoCloseOutOfRange && snapshot.inRange === false) {
    close = { reason: "OUT_OF_RANGE", pnlPct };
  }

  const intervalMin = Number(automation.alertIntervalMin);
  const lastAlertMs = automation.lastAlertAt ? Date.parse(automation.lastAlertAt) : 0;
  const alert = Number.isFinite(intervalMin) && intervalMin > 0
    && (!lastAlertMs || now - lastAlertMs >= intervalMin * 60_000);

  return { pnlPct, close, alert };
}

/**
 * Enforce saved automation settings once per monitoring cycle.
 * `notify` receives plain text alerts (typically notifyTelegram).
 */
export async function monitorAutomations(ctx, { notify = null } = {}) {
  const config = ctx?.config;
  if (!ctx?.router) return { checked: 0, closed: 0, alerts: 0 };
  const filePath = automationFilePath(config);
  const store = loadAutomations(filePath);
  let checked = 0;
  let closed = 0;
  let alerts = 0;
  let changed = false;

  for (const automation of Object.values(store.automations)) {
    if (automation.status === "closed") continue;
    checked += 1;
    try {
      const numericTokenId = /^\d+$/.test(String(automation.tokenId || ""));
      if (!numericTokenId || automation.shadow) continue;
      const client = ctx.router.get(automation.chain);
      const position = await client.getPosition(automation.tokenId, { refresh: true });
      const currentPrice = automation.baseIsToken0
        ? Number(position.currentPrice)
        : (Number(position.currentPrice) > 0 ? 1 / Number(position.currentPrice) : null);

      const evaluation = evaluateAutomation({
        automation,
        snapshot: { currentPrice, inRange: position.inRange },
      });

      if (evaluation.close) {
        const updated = await executeClose(ctx, automation, evaluation.close.reason);
        if (updated.simulatedClose) {
          // Shadow mode: keep the on-chain automation open and throttle a
          // would-have-closed notice through the normal alert interval.
          if (evaluation.alert) {
            const stamped = updateAutomation(
              automation.id,
              { lastAlertAt: new Date().toISOString() },
              { filePath },
            );
            store.automations[automation.id] = stamped;
            changed = true;
            alerts += 1;
            if (notify) {
              await notify(
                `Morpheus EVM DRY-RUN would close ${automation.baseSymbol || "?"}/`
                + `${automation.quoteSymbol || "?"} (${evaluation.close.reason})`,
              );
            }
          }
          continue;
        }
        store.automations[automation.id] = updated;
        changed = true;
        closed += 1;
        if (notify) {
          await notify(
            `Morpheus EVM automation closed ${automation.baseSymbol || "?"}/`
            + `${automation.quoteSymbol || "?"} (${evaluation.close.reason})`
            + ` PnL ${evaluation.pnlPct == null ? "n/a" : `${evaluation.pnlPct.toFixed(2)}%`}`,
          );
        }
        continue;
      }

      if (evaluation.alert) {
        const updated = updateAutomation(
          automation.id,
          { lastAlertAt: new Date().toISOString() },
          { filePath },
        );
        store.automations[automation.id] = updated;
        changed = true;
        alerts += 1;
        if (notify) {
          await notify(
            `Morpheus EVM LP alert ${automation.baseSymbol || "?"}/`
            + `${automation.quoteSymbol || "?"}:`
            + ` price=${currentPrice ?? "n/a"}`
            + ` pnl=${evaluation.pnlPct == null ? "n/a" : `${evaluation.pnlPct.toFixed(2)}%`}`
            + ` range=${position.inRange ? "IN" : "OUT"}`,
          );
        }
      }
    } catch (error) {
      log(
        "panda_warn",
        `Automation ${automation.id} check failed: ${error?.message || String(error)}`,
      );
    }
  }

  if (changed) saveAutomations(store, filePath);
  return { checked, closed, alerts };
}


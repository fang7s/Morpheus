#!/usr/bin/env node
// ─── Prometheus EVM entry point ─────────────────────────────────────
// Evil Panda concentrated-liquidity exit bot for Uniswap v3 on Arbitrum, Base,
// Ethereum Mainnet, BNB Smart Chain and Robinhood Chain.
// Shadow/dry-run mode is ON by default and performs no writes.

import express from "express";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { UniswapV3 } from "./tools/uniswap-v3.js";
import {
  checkEvilPandaExitConfluence,
  clearPriceSeriesCaches,
  createExitConfirmation,
  describeExitEngine,
  fetchPriceSeries,
  getPriceSeriesCacheStats,
} from "./tools/evil-panda.js";

const HELP = `Prometheus EVM — Uniswap v3 Evil Panda LP bot

Usage:
  node index.js [options]

Options:
  --once              Run one evaluation cycle and exit
  --check             Validate config and print a summary (no RPC calls)
  --chain <name>      Override chain: arbitrum | base | ethereum | bnb | robinhood
                      (aliases: eth, mainnet, bsc, binance, orbit)
  --config <path>     Use a specific user-config JSON file
  --reset-cache       Clear in-memory price caches before starting
  --help              Show this help

Environment:
  DRY_RUN                            default true
  I_UNDERSTAND_LIVE_TRADING=true     required together with DRY_RUN=false
  PRIVATE_KEY                        required for live trading
  RPC_URL / CHAIN / POLL_INTERVAL_MS / LOG_LEVEL
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
`;

function parseArgs(argv) {
  const args = {
    once: false,
    check: false,
    resetCache: false,
    help: false,
    chain: null,
    config: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split("=", 2);
    switch (flag) {
      case "--once":
        args.once = true;
        break;
      case "--check":
        args.check = true;
        break;
      case "--reset-cache":
        args.resetCache = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--chain":
        args.chain = inline || argv[++i] || null;
        break;
      case "--config":
        args.config = inline || argv[++i] || null;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function shortAddress(address) {
  const value = String(address || "");
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function printBanner(config) {
  log("startup", "────────────────────────────────────────────────────────");
  log("startup", "Prometheus EVM — Uniswap v3 Evil Panda LP bot");
  log("startup", `Chain: ${config.chainConfig.name} (${config.chainId})`);
  log("startup", `RPC: ${config.rpcUrl} (${config.rpcUrls.length} preset${config.rpcUrls.length === 1 ? "" : "s"})`);
  log("startup", `Mode: ${config.dryRun ? "SHADOW / DRY-RUN (no writes)" : "LIVE TRADING"}`);
  log("startup", `Factory: ${config.factory}`);
  log("startup", `PositionManager: ${config.positionManager}`);
  log("startup", `Exit engine: ${describeExitEngine(config.panda)}`);
  log("startup", `Poll interval: ${config.pollIntervalMs}ms`);
  log("startup", `Positions configured: ${config.positions.length} | discovery: ${config.discovery.enabled ? "on" : "off"}`);
  log("startup", `Config file: ${config.configPath || "(none — defaults + .env)"}`);
  for (const warning of config.warnings || []) log("startup_warn", warning);
  log("startup", "────────────────────────────────────────────────────────");
}

function printCheck(config) {
  const lines = [
    `chain=${config.chain} chainId=${config.chainId}`,
    `mode=${config.dryRun ? "shadow" : "LIVE"}`,
    `rpc=${config.rpcUrl}`,
    `rpcPresets=${config.rpcUrls.join(", ")}`,
    `positionManager=${config.positionManager}`,
    `factory=${config.factory}`,
    `panda=${describeExitEngine(config.panda)}`,
    `priceFeed=buffer:${config.priceFeed.bufferSize} geckoCooldown:${config.priceFeed.geckoCooldownMs}ms`,
    `positions=${config.positions.length}${config.positions.length
      ? ` [${config.positions.map((p) => p.label).join(", ")}]`
      : ""}`,
    `discovery=${config.discovery.enabled ? config.discovery.wallet : "disabled"}`,
    `telegram=${config.telegram.enabled ? "enabled" : "disabled"}`,
    `health=${config.health.enabled ? `:${config.health.port}` : "disabled"}`,
  ];
  for (const line of lines) log("check", line);
  if (config.positions.length === 0 && !config.discovery.enabled) {
    log(
      "check_warn",
      "No positions configured. Copy user-config.example.json to user-config.json to start monitoring.",
    );
  }
  log("check", "Configuration OK.");
}

function positionKey(position) {
  return `${position.pool.toLowerCase()}:${position.tokenId || position.label}`;
}

/**
 * Resolve configured positions and optionally discover wallet positions.
 * A definition with only token0/token1/fee resolves its pool via Factory.
 */
async function resolvePositions(config, client) {
  const resolved = [];
  const seen = new Set();

  function add(position) {
    const key = positionKey(position);
    if (seen.has(key)) return;
    seen.add(key);
    resolved.push(position);
  }

  for (const def of config.positions) {
    try {
      let pool = def.pool;
      let token0 = def.token0;
      let token1 = def.token1;
      let fee = def.fee;
      let onchain = null;

      if (def.tokenId) {
        onchain = await client.getPosition(def.tokenId);
        pool = pool || onchain.pool;
        token0 = token0 || onchain.token0;
        token1 = token1 || onchain.token1;
        fee = fee ?? onchain.fee;
      }
      if (!pool) {
        if (!token0 || !token1 || fee == null) {
          throw new Error("needs pool, or token0/token1/fee to resolve one");
        }
        pool = await client.getPoolAddress({ tokenA: token0, tokenB: token1, fee });
      }

      const state = await client.getPoolState(pool);
      const baseToken = def.baseToken || await client.resolveBaseToken(pool, null);
      add({
        ...def,
        pool,
        token0: token0 || state.token0,
        token1: token1 || state.token1,
        fee: fee ?? state.fee,
        baseToken,
        tokenId: def.tokenId || null,
        state,
        onchain,
      });
      log(
        "startup",
        `Watching ${def.label}: ${state.token0Symbol || shortAddress(state.token0)}/`
        + `${state.token1Symbol || shortAddress(state.token1)} fee=${state.fee} `
        + `pool=${shortAddress(pool)}${def.tokenId ? ` tokenId=${def.tokenId}` : " (shadow watch)"}`,
      );
    } catch (error) {
      log("panda_warn", `Skipping position "${def.label}": ${error.message}`);
    }
  }

  if (config.discovery.enabled) {
    const owner = client.walletAddress || config.discovery.wallet;
    if (!owner) {
      log("panda_warn", "Discovery is enabled but no wallet address is available.");
    } else {
      try {
        const walletPositions = await client.getWalletPositions(owner, {
          limit: config.discovery.maxPositions,
        });
        for (const onchain of walletPositions) {
          const baseToken = await client.resolveBaseToken(onchain.pool, null);
          add({
            label: `wallet-${onchain.tokenId}`,
            pool: onchain.pool,
            tokenId: onchain.tokenId,
            token0: onchain.token0,
            token1: onchain.token1,
            baseToken,
            fee: onchain.fee,
            amountUsd: null,
            notes: "discovered on-chain",
            onchain,
          });
        }
        log("startup", `Discovered ${walletPositions.length} wallet position(s) for ${shortAddress(owner)}`);
      } catch (error) {
        log("panda_warn", `Wallet position discovery failed: ${error.message}`);
      }
    }
  }

  return resolved;
}

/** Fetch the multi-layer price series and run the Evil Panda confluence. */
async function evaluatePosition(config, client, position) {
  const baseToken = position.baseToken || await client.resolveBaseToken(position.pool, null);
  const series = await fetchPriceSeries({
    chain: config.chain,
    pool_address: position.pool,
    token_address: baseToken,
    timeframe: config.panda.timeframe,
    limit: config.panda.candles,
    cacheSec: config.panda.cacheSec,
    settings: config.priceFeed,
    getSlot0Price: () => client.getPriceInBase(position.pool, baseToken),
  });
  const result = checkEvilPandaExitConfluence(
    series.prices,
    series.currentPrice,
    config.panda,
  );
  return { series, result, baseToken };
}

async function notifyTelegram(config, text) {
  if (!config.telegram.enabled) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
  } catch (error) {
    log("panda_warn", `Telegram alert failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Dry-run exits are logged only; live exits call the NPM. */
async function handleExit({ config, client, position, evaluation, signalReason }) {
  const priceText = evaluation.series.currentPrice != null
    ? ` price=${evaluation.series.currentPrice}`
    : "";
  const base = `[${position.label}] ${signalReason}${priceText} `
    + `[${evaluation.series.source}, ${evaluation.series.prices.length} samples, ${evaluation.series.timeframe}]`;

  if (config.dryRun || !position.tokenId) {
    const detail = config.dryRun
      ? "DRY-RUN: no transaction sent"
      : "no tokenId (shadow watch): no transaction sent";
    log("panda_exit", `[SHADOW] ${base} | ${detail}`);
    await notifyTelegram(config, `Prometheus EVM SHADOW exit\n${base}\n${detail}`);
    return {
      shadow: true,
      reason: signalReason,
      pool: position.pool,
      tokenId: position.tokenId,
      price: evaluation.series.currentPrice,
      source: evaluation.series.source,
      at: new Date().toISOString(),
    };
  }

  log("panda_exit", `[LIVE] ${base} | closing position ${position.tokenId}`);
  const result = await client.closePosition(position.tokenId, config.exit);
  await notifyTelegram(
    config,
    `Prometheus EVM LIVE exit\n${base}\ntx=${result.txHashes.join(", ")}`,
  );
  return result;
}

/** One evaluation pass over all resolved positions. */
async function runCycle(ctx) {
  const { config, client, positions, confirmation, runtime } = ctx;
  if (ctx.busy) return;
  ctx.busy = true;
  runtime.polls += 1;

  try {
    if (positions.length === 0) {
      log("panda_warn", "No positions resolved; nothing to monitor this cycle.");
      return;
    }

    for (const position of positions) {
      const key = positionKey(position);
      const tracked = runtime.tracked.get(key) || { exited: false, last: null };
      if (tracked.exited) continue;

      try {
        const evaluation = await evaluatePosition(config, client, position);
        const { series, result } = evaluation;
        const sampleCount = series.prices?.length || 0;

        if (sampleCount < config.panda.minCandles) {
          log(
            "panda",
            `[${position.label}] waiting for price history ${sampleCount}/${config.panda.minCandles} `
            + `(price=${series.currentPrice ?? "n/a"}, source=${series.source})`,
          );
          tracked.last = {
            at: new Date().toISOString(),
            price: series.currentPrice,
            source: series.source,
            samples: sampleCount,
            shouldExit: false,
          };
          runtime.tracked.set(key, tracked);
          continue;
        }

        const signal = result.shouldExit ? "EVIL_PANDA" : null;
        const confirm = confirmation.confirm(key, signal);
        const rsiText = result.rsi != null ? result.rsi.toFixed(2) : "n/a";

        log(
          "panda",
          `[${position.label}] price=${series.currentPrice} RSI=${rsiText} `
          + `BB=${result.bbTriggered ? "penetrated" : "inside"} `
          + `MACD=${result.macdHistogram != null && result.macdHistogram > 0 ? "positive" : "negative"} `
          + `source=${series.source} samples=${sampleCount}`,
        );

        if (signal) {
          log(
            "panda",
            `[${position.label}] EXIT signal pending confirmation ${confirm.count}/${confirm.required}`,
          );
        }

        tracked.last = {
          at: new Date().toISOString(),
          price: series.currentPrice,
          source: series.source,
          samples: sampleCount,
          rsi: result.rsi,
          shouldExit: result.shouldExit,
          count: confirm.count,
          required: confirm.required,
        };

        if (confirm.fire) {
          tracked.exit = await handleExit({
            config,
            client,
            position,
            evaluation,
            signalReason: result.reason,
          });
          tracked.exited = true;
          runtime.exits.push(tracked.exit);
          confirmation.reset(key);
          log("panda", `[${position.label}] exit confirmed after ${confirm.required} ticks.`);
        }

        runtime.tracked.set(key, tracked);
      } catch (error) {
        runtime.errors += 1;
        log("panda_warn", `[${position.label}] evaluation failed: ${error.message}`);
      }
    }
  } finally {
    runtime.lastCycleAt = new Date().toISOString();
    ctx.busy = false;
  }
}

/** Optional HTTP health/status endpoint. */
function startHealthServer(ctx) {
  const { config, positions, runtime } = ctx;
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      chain: config.chain,
      chainId: config.chainId,
      mode: config.dryRun ? "shadow" : "live",
      startedAt: runtime.startedAt,
      lastCycleAt: runtime.lastCycleAt,
      uptimeSec: Math.floor((Date.now() - runtime.startedAtMs) / 1_000),
      positions: positions.length,
      polls: runtime.polls,
      exits: runtime.exits.length,
      errors: runtime.errors,
      priceFeed: getPriceSeriesCacheStats(),
    });
  });

  app.get("/positions", (_req, res) => {
    res.json(positions.map((position) => ({
      label: position.label,
      pool: position.pool,
      tokenId: position.tokenId,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      baseToken: position.baseToken,
      state: runtime.tracked.get(positionKey(position)) || null,
    })));
  });

  const server = app.listen(config.health.port, "127.0.0.1", () => {
    log("startup", `Health endpoint listening on http://127.0.0.1:${config.health.port}/health`);
  });
  server.on("error", (error) => {
    log("startup_warn", `Health server failed: ${error.message}`);
  });
  return server;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  // --check may run on a fresh checkout with no user-config.json, but every
  // other rule (live key/acknowledgement, addresses, indicator bounds) still
  // applies. Only the "no positions configured" rule is relaxed.
  const config = loadConfig({
    chain: args.chain,
    configPath: args.config,
    allowEmptyPositions: args.check,
  });

  printBanner(config);
  if (args.check) {
    printCheck(config);
    return;
  }

  if (args.resetCache) {
    clearPriceSeriesCaches();
    log("startup", "In-memory price caches cleared.");
  }

  const client = new UniswapV3(config);
  const positions = await resolvePositions(config, client);

  if (positions.length === 0) {
    log(
      "startup_warn",
      "No positions resolved. Add positions to user-config.json, or enable discovery with a wallet address.",
    );
    client.destroy();
    process.exitCode = 1;
    return;
  }

  const ctx = {
    config,
    client,
    positions,
    confirmation: createExitConfirmation(config.panda.confirmTicks),
    busy: false,
    runtime: {
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      lastCycleAt: null,
      polls: 0,
      exits: [],
      errors: 0,
      tracked: new Map(),
    },
  };

  const server = config.health.enabled ? startHealthServer(ctx) : null;
  let timer = null;
  let shuttingDown = false;

  async function shutdown(reason, exitProcess = true) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown", `Stopping (${reason})…`);
    if (timer) clearInterval(timer);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      log("shutdown", "Health server closed.");
    }
    client.destroy();
    log("shutdown", "Stopped.");
    if (exitProcess) process.exit(0);
  }

  process.once("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
  process.once("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });

  if (args.once) {
    await runCycle(ctx);
    const summary = {
      positions: positions.length,
      exits: ctx.runtime.exits.length,
      errors: ctx.runtime.errors,
      lastCycleAt: ctx.runtime.lastCycleAt,
    };
    log("panda", `Single cycle complete: ${JSON.stringify(summary)}`);
    await shutdown("once", false);
    return;
  }

  await runCycle(ctx);
  timer = setInterval(() => {
    runCycle(ctx).catch((error) => {
      log("error", `Cycle error: ${error.message}`);
    });
  }, config.pollIntervalMs);
  log(
    "startup",
    `Poller running every ${config.pollIntervalMs}ms across ${positions.length} position(s). `
    + `Exit requires ${config.panda.confirmTicks} consecutive confirming ticks.`,
  );
}

main().catch((error) => {
  log("startup_error", error?.stack || error?.message || String(error));
  process.exitCode = 1;
});




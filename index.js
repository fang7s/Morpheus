#!/usr/bin/env node
// ─── Morpheus EVM entry point ───────────────────────────────────────
// Evil Panda concentrated-liquidity exit bot for Uniswap v3 on Arbitrum, Base,
// Ethereum Mainnet, BNB Smart Chain and Robinhood Chain.
// Shadow/dry-run mode is ON by default and performs no writes.

import express from "express";
import { chainInfo, chainRuntimeConfig, loadConfig } from "./config.js";
import { log } from "./logger.js";
import { UniswapV3 } from "./tools/uniswap-v3.js";
import {
  clearDiscoveryCache,
  configuredWallet,
  discoverWalletPositions,
} from "./tools/discovery.js";
import { positionKey } from "./tools/position-key.js";
import {
  notifyTelegram,
  startTelegramCommandPoller,
} from "./tools/telegram-commands.js";
import {
  checkEvilPandaExitConfluence,
  clearPriceSeriesCaches,
  createExitConfirmation,
  describeExitEngine,
  fetchPriceSeries,
  getPriceSeriesCacheStats,
} from "./tools/evil-panda.js";

const HELP = `Morpheus EVM — Uniswap v3 Evil Panda LP bot

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
  CHAIN                              default chain for unqualified positions
  ETH_RPC_URL(S) / BSC_RPC_URL(S)    per-chain RPC routes
  BASE_RPC_URL(S) / ROBINHOOD_RPC_URL(S)
  ARBITRUM_RPC_URL(S) / RPC_URL      additional RPC overrides
  DRY_RUN / SHADOW_MODE              default true (DRY_RUN wins if both set)
  I_UNDERSTAND_LIVE_TRADING=true     required together with DRY_RUN=false
  WALLET_PRIVATE_KEY                 required for live trading (PRIVATE_KEY alias)
  PORT / HEALTH_ENABLED              local health endpoint
  POLL_INTERVAL_MS / LOG_LEVEL
  TELEGRAM_ENABLED                  exit/alert notifications
  TELEGRAM_COMMANDS_ENABLED         interactive command menu
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
  INDEXER_API_URL / SUBGRAPH_URL_<chainId>   pool fee-tier indexer fallback
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

/**
 * Lazily create one UniswapV3 client per chain. Each client reads its own
 * .env-configured RPC route, so positions on different chains never share a
 * provider or fallback array.
 */
function createClientRouter(config) {
  const clients = new Map();
  return {
    get(chainKey) {
      const chain = chainInfo(chainKey);
      if (!clients.has(chain.key)) {
        const chainConfig = chainRuntimeConfig(config, chain.key);
        clients.set(chain.key, new UniswapV3(chainConfig));
        log(
          "startup",
          `RPC route ${chain.key}: ${chainConfig.rpcUrls.length} endpoint(s), `
          + `primary ${chainConfig.rpcUrl}`,
        );
      }
      return clients.get(chain.key);
    },
    destroy() {
      for (const client of clients.values()) client.destroy();
      clients.clear();
    },
  };
}

function printBanner(config) {
  log("startup", "────────────────────────────────────────────────────────");
  log("startup", "Morpheus EVM — Uniswap v3 Evil Panda LP bot");
  log("startup", `Chain: ${config.chainConfig.name} (${config.chainId})`);
  log("startup", `RPC: ${config.rpcUrl} (${config.rpcUrls.length} preset${config.rpcUrls.length === 1 ? "" : "s"})`);
  log("startup", `RPC routes: ${Object.keys(config.rpcByChain || {}).join(", ")}`);
  log("startup", `Mode: ${config.dryRun ? "SHADOW / DRY-RUN (no writes)" : "LIVE TRADING"}`);
  log("startup", `Factory: ${config.factory}`);
  log("startup", `PositionManager: ${config.positionManager}`);
  log("startup", `Exit engine: ${describeExitEngine(config.panda)}`);
  log("startup", `Poll interval: ${config.pollIntervalMs}ms`);
  log("startup", `Positions configured: ${config.positions.length} | discovery: ${config.discovery.enabled ? "on" : "off"}`);
  log("startup", `Telegram commands: ${config.telegram.commandsEnabled ? "on" : "off"}`);
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
    `chains=${Object.keys(config.rpcByChain || {}).join(",")}`,
    ...Object.entries(config.rpcByChain || {}).map(
      ([chainKey, urls]) => `rpc.${chainKey}=${urls[0]} (${urls.length})`,
    ),
    `positionManager=${config.positionManager}`,
    `factory=${config.factory}`,
    `panda=${describeExitEngine(config.panda)}`,
    `priceFeed=buffer:${config.priceFeed.bufferSize} geckoCooldown:${config.priceFeed.geckoCooldownMs}ms`,
    `positions=${config.positions.length}${config.positions.length
      ? ` [${config.positions.map((p) => p.label).join(", ")}]`
      : ""}`,
    `discovery=${config.discovery.enabled
      ? (config.discovery.wallet || configuredWallet(config) || "enabled") : "disabled"}`,
    `telegram=${config.telegram.enabled ? "alerts-on" : "alerts-off"} `
      + `commands=${config.telegram.commandsEnabled ? "on" : "off"}`,
    `health=${config.health.enabled ? `:${config.health.port}` : "disabled"}`,
    `indexer=${!config.indexer?.enabled
      ? "disabled"
      : config.indexer.url
        ? `${config.indexer.type} ${config.indexer.url}`
        : Object.keys(config.indexer.byChain || {}).length
          ? `${Object.keys(config.indexer.byChain).length} chain endpoint(s)`
          : "no endpoint configured"}`,
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

/**
 * Resolve configured positions and optionally discover wallet positions.
 * A definition with only token0/token1/fee resolves its pool via Factory.
 */
async function resolvePositions(config, router) {
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
      const chainKey = def.chain || config.chain;
      const client = router.get(chainKey);
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
        chain: chainKey,
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
        `Watching ${def.label} on ${chainKey}: `
        + `${state.token0Symbol || shortAddress(state.token0)}/`
        + `${state.token1Symbol || shortAddress(state.token1)} fee=${state.fee} `
        + `pool=${shortAddress(pool)}${def.tokenId ? ` tokenId=${def.tokenId}` : " (shadow watch)"}`,
      );
    } catch (error) {
      log("panda_warn", `Skipping position "${def.label}": ${error.message}`);
    }
  }

  if (config.discovery.enabled) {
    const discovery = await discoverWalletPositions({
      config,
      router,
      limit: config.discovery.maxPositions,
      refresh: true,
    });
    if (!discovery.wallet) {
      log("startup_warn", "Discovery is enabled but no wallet address is available yet.");
    } else {
      for (const position of discovery.positions) add(position);
      log(
        "startup",
        `Discovered ${discovery.positions.length} wallet position(s) across `
        + `${discovery.chains.length} chain(s) for ${shortAddress(discovery.wallet)}`,
      );
    }
  }

  return resolved;
}

/** Fetch the multi-layer price series and run the Evil Panda confluence. */
async function evaluatePosition(config, client, position) {
  const chain = chainInfo(position.chain);
  const baseToken = position.baseToken || await client.resolveBaseToken(position.pool, null);
  const series = await fetchPriceSeries({
    chain: chain.key,
    geckoNetwork: chain.geckoNetwork,
    dexscreenerChain: chain.dexscreenerChain,
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

/** Dry-run exits are logged only; live exits call the NPM. */
async function handleExit({
  config,
  client,
  position,
  evaluation,
  signalReason,
  entryPrice,
  amountUsd,
}) {
  const exitPrice = evaluation.series.currentPrice;
  const entry = Number(entryPrice);
  const amount = Number(amountUsd);
  const pnlPct = Number.isFinite(entry) && entry > 0 && Number.isFinite(exitPrice)
    ? ((exitPrice / entry) - 1) * 100
    : null;
  const pnlUsd = pnlPct != null && Number.isFinite(amount) && amount > 0
    ? amount * (pnlPct / 100)
    : null;
  const state = position.state || {};
  const meta = {
    label: position.label,
    pair: `${state.token0Symbol || position.token0 || "?"}/`
      + `${state.token1Symbol || position.token1 || "?"}`,
    chain: position.chain,
    chainId: position.chainId,
    entryPrice: Number.isFinite(entry) && entry > 0 ? entry : null,
    exitPrice: Number.isFinite(exitPrice) ? exitPrice : null,
    amountUsd: Number.isFinite(amount) && amount > 0 ? amount : null,
    pnlPct,
    pnlUsd,
    at: new Date().toISOString(),
  };

  const priceText = exitPrice != null ? ` price=${exitPrice}` : "";
  const base = `[${position.label}] ${signalReason}${priceText} `
    + `[${evaluation.series.source}, ${evaluation.series.prices.length} samples, ${evaluation.series.timeframe}]`;

  if (config.dryRun || !position.tokenId) {
    const detail = config.dryRun
      ? "DRY-RUN: no transaction sent"
      : "no tokenId (shadow watch): no transaction sent";
    log("panda_exit", `[SHADOW] ${base} | ${detail}`);
    await notifyTelegram(config, `Morpheus EVM SHADOW exit\n${base}\n${detail}`);
    return {
      shadow: true,
      reason: signalReason,
      ...meta,
      pool: position.pool,
      tokenId: position.tokenId,
      price: exitPrice,
      source: evaluation.series.source,
    };
  }

  log("panda_exit", `[LIVE] ${base} | closing position ${position.tokenId}`);
  const result = await client.closePosition(position.tokenId, config.exit);
  await notifyTelegram(
    config,
    `Morpheus EVM LIVE exit\n${base}\ntx=${result.txHashes.join(", ")}`,
  );
  return { ...result, ...meta };
}

/** One evaluation pass over all resolved positions. */
async function runCycle(ctx) {
  const { config, router, positions, confirmation, runtime } = ctx;
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
      const tracked = runtime.tracked.get(key) || {
        exited: false,
        last: null,
        entryPrice: null,
        entryAt: null,
      };
      if (tracked.exited) continue;

      try {
        const client = router.get(position.chain);
        const evaluation = await evaluatePosition(config, client, position);
        const { series, result } = evaluation;
        const sampleCount = series.prices?.length || 0;

        if (tracked.entryPrice == null
          && Number.isFinite(series.currentPrice)
          && series.currentPrice > 0) {
          tracked.entryPrice = series.currentPrice;
          tracked.entryAt = new Date().toISOString();
        }

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
            entryPrice: tracked.entryPrice,
            amountUsd: position.amountUsd,
          });
          tracked.exited = true;
          runtime.exits.push(tracked.exit);
          if (runtime.exits.length > 200) {
            runtime.exits.splice(0, runtime.exits.length - 200);
          }
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
      chains: [...new Set(positions.map((position) => position.chain))],
      rpcRoutes: Object.fromEntries(
        Object.entries(config.rpcByChain || {}).map(([key, urls]) => [key, urls.length]),
      ),
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
      chain: position.chain,
      chainId: position.chainId,
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

  const router = createClientRouter(config);
  const positions = await resolvePositions(config, router);

  if (positions.length === 0) {
    log(
      "startup_warn",
      "No explicit or discovered positions yet. Continuing startup; Telegram "
      + "/positions and /wallet will retry wallet discovery on demand.",
    );
  }

  const ctx = {
    config,
    router,
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
  let telegramCommands = null;
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
    telegramCommands?.stop();
    clearDiscoveryCache();
    router.destroy();
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
  telegramCommands = startTelegramCommandPoller(ctx);
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

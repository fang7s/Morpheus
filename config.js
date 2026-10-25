// ─── Morpheus EVM configuration ─────────────────────────────────────
// Loads .env + user-config.json (optional) into a validated config object.
// Everything here is local to morpheus/; no external config is read.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const PRIVATE_KEY_RE = /^0x[a-fA-F0-9]{64}$/;

/** Uniswap v3 deployments and canonical bridged tokens per chain. */
export const CHAINS = {
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    rpcUrls: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-rpc.publicnode.com",
    ],
    geckoNetwork: "arbitrum",
    dexscreenerChain: "arbitrum",
    explorer: "https://arbiscan.io",
    nativeSymbol: "ETH",
    wrappedNative: "WETH",
    aliases: ["arb", "arbitrum-one"],
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    tokens: {
      WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      "USDC.e": "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
      USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    },
  },
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    rpcUrls: [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
      "https://base.llamarpc.com",
    ],
    geckoNetwork: "base",
    dexscreenerChain: "base",
    explorer: "https://basescan.org",
    nativeSymbol: "ETH",
    wrappedNative: "WETH",
    aliases: ["base-mainnet"],
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    tokens: {
      WETH: "0x4200000000000000000000000000000000000006",
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      WBTC: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
      cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    },
  },
  ethereum: {
    key: "ethereum",
    name: "Ethereum Mainnet",
    chainId: 1,
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    rpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.llamarpc.com",
      "https://cloudflare-eth.com",
    ],
    geckoNetwork: "eth",
    dexscreenerChain: "ethereum",
    explorer: "https://etherscan.io",
    nativeSymbol: "ETH",
    wrappedNative: "WETH",
    aliases: ["eth", "mainnet", "ethereum-mainnet"],
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    tokens: {
      WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      USDG: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D",
      LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    },
  },
  bnb: {
    key: "bnb",
    name: "BNB Smart Chain",
    chainId: 56,
    rpcUrl: "https://bsc-rpc.publicnode.com",
    rpcUrls: [
      "https://bsc-rpc.publicnode.com",
      "https://bsc-dataseed.binance.org",
      "https://bsc-dataseed1.defibit.io",
    ],
    geckoNetwork: "bsc",
    dexscreenerChain: "bsc",
    explorer: "https://bscscan.com",
    nativeSymbol: "BNB",
    wrappedNative: "WBNB",
    aliases: ["bsc", "binance", "bnb-chain", "bnb-smart-chain"],
    factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    positionManager: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
    quoterV2: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    tokens: {
      WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      WETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
      USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      USDT: "0x55d398326f99059fF775485246999027B3197955",
      DAI: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3",
      BTCB: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
      BUSD: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    },
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    rpcUrls: [
      "https://rpc.mainnet.chain.robinhood.com",
      "https://robinhood-rpc.publicnode.com",
      "https://robinhood.drpc.org",
    ],
    geckoNetwork: "robinhood",
    dexscreenerChain: "robinhood",
    explorer: "https://robinhoodchain.blockscout.com",
    nativeSymbol: "ETH",
    wrappedNative: "WETH",
    aliases: ["robinhood-chain", "orbit", "rhc"],
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    quoterV2: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
    tokens: {
      WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      cbBTC: "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4",
      W0G: "0x32003CC8357938bCF615c1222a349c58f2B30698",
    },
  },
};

/**
 * .env prefixes for per-chain RPC auto-routing. Both `<PREFIX>_RPC_URL` and
 * `<PREFIX>_RPC_URLS` (comma/space separated) are read for every chain, so all
 * EVM endpoints can be configured simultaneously.
 */
export const RPC_ENV_PREFIXES = {
  ethereum: ["ETH", "ETHEREUM"],
  bnb: ["BSC", "BNB"],
  base: ["BASE"],
  robinhood: ["ROBINHOOD", "RHC"],
  arbitrum: ["ARBITRUM", "ARB"],
};

const DEFAULTS = {
  chain: "arbitrum",
  rpcUrl: "",
  rpcUrls: [],
  dryRun: true,
  pollIntervalMs: 15_000,
  panda: {
    enabled: true,
    timeframe: "5m",
    candles: 120,
    cacheSec: 60,
    confirmTicks: 3,
    rsiPeriod: 2,
    // Evil Panda overbought band is 70-80 in this bot. The earlier reference
    // implementation used >90; 80 is the documented top of the requested band.
    rsiOverbought: 80,
    bbPeriod: 20,
    bbStdDev: 2,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    // "any" = RSI AND (BB penetration OR MACD shift) — reference confluence.
    // "all" = RSI AND BB AND MACD.
    confluenceMode: "any",
    requireMacdShift: false,
    minCandles: 35,
  },
  priceFeed: {
    bufferSize: 50,
    bufferMaxAgeMs: 30 * 60_000,
    staleSeriesMaxMs: 30 * 60_000,
    degradedCacheMs: 10_000,
    geckoCooldownMs: 60_000,
    fetchTimeoutMs: 8_000,
    resolvedTokenCacheMs: 10 * 60_000,
  },
  positions: [],
  discovery: {
    enabled: true,
    wallet: "",
    maxPositions: 10,
  },
  risk: {
    // Informational shadow-mode guardrails; panda exit is the primary engine.
    stopLossPct: -50,
    takeProfitPct: 25,
  },
  exit: {
    burnAfterExit: true,
    slippageBps: 100,
    deadlineSec: 1_200,
  },
  health: { enabled: false, port: 3010 },
  telegram: { enabled: false, botToken: "", chatId: "" },
};

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith("_")) continue;
    out[key] = isPlainObject(value) && isPlainObject(base?.[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return out;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read config ${filePath}: ${error.message}`);
  }
}

function asBool(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no|off)$/i.test(String(value).trim());
}

function positiveInt(value, fallback, min = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

/** Split a comma/whitespace-separated RPC list into trimmed, non-empty URLs. */
function splitRpcList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}

/** Collect every RPC env var configured for a chain, highest priority first. */
function envRpcsForChain(chainKey) {
  const prefixes = RPC_ENV_PREFIXES[chainKey] || [chainKey.toUpperCase()];
  const urls = [];
  for (const prefix of prefixes) {
    urls.push(...splitRpcList(process.env[`${prefix}_RPC_URL`]));
    urls.push(...splitRpcList(process.env[`${prefix}_RPC_URLS`]));
  }
  return [...new Set(urls)];
}

/**
 * Build one independent RPC route per chain. The default chain also honours the
 * legacy global RPC_URL and user-config rpcUrl/rpcUrls overrides; other chains
 * use their own .env vars, then the built-in public presets.
 */
function buildRpcByChain(defaultChain, merged) {
  const map = {};
  const userRpcUrls = [
    String(merged.rpcUrl || "").trim(),
    ...(Array.isArray(merged.rpcUrls) ? merged.rpcUrls : []),
  ].map((url) => String(url || "").trim()).filter(Boolean);

  for (const chain of Object.values(CHAINS)) {
    const isDefault = chain.key === defaultChain.key;
    const envUrls = envRpcsForChain(chain.key);
    map[chain.key] = [...new Set([
      ...(isDefault ? splitRpcList(process.env.RPC_URL) : []),
      ...envUrls,
      ...(isDefault ? userRpcUrls : []),
      ...chain.rpcUrls,
    ])];
  }
  return map;
}

function resolveChain(value) {
  const key = String(value || "arbitrum").trim().toLowerCase();
  const direct = CHAINS[key];
  if (direct) return direct;
  const aliased = Object.values(CHAINS).find(
    (chain) => Array.isArray(chain.aliases) && chain.aliases.includes(key),
  );
  if (aliased) return aliased;
  throw new Error(`Unsupported chain "${value}". Use one of: ${Object.keys(CHAINS).join(", ")}`);
}

function resolveToken(chain, value) {
  if (!value) return null;
  const raw = String(value).trim();
  const bySymbol = chain.tokens[raw] || chain.tokens[raw.toUpperCase()];
  if (bySymbol) return bySymbol;
  if (ADDRESS_RE.test(raw)) return raw;
  return null;
}

/** Resolve a position's chain from an explicit key or numeric chainId. */
function resolvePositionChain(position, defaultChain) {
  let chain = defaultChain;
  const hasChain = position.chain != null && String(position.chain).trim() !== "";
  const hasChainId = position.chainId != null && String(position.chainId).trim() !== "";

  if (hasChain) chain = resolveChain(position.chain);
  if (hasChainId) {
    const chainId = Number(position.chainId);
    const byId = Object.values(CHAINS).find((entry) => entry.chainId === chainId);
    if (!byId) {
      throw new Error(`unsupported chainId ${position.chainId}`);
    }
    if (hasChain && byId.key !== chain.key) {
      throw new Error(`chain "${chain.key}" conflicts with chainId ${chainId}`);
    }
    chain = byId;
  }
  return chain;
}

/** Resolve a position definition into concrete chain + token addresses. */
function normalizePositions(positions, defaultChain) {
  if (!Array.isArray(positions)) return [];
  return positions.map((position, index) => {
    if (!isPlainObject(position)) {
      throw new Error(`positions[${index}] must be an object`);
    }
    const chain = resolvePositionChain(position, defaultChain);
    const token0 = resolveToken(chain, position.token0);
    const token1 = resolveToken(chain, position.token1);
    const baseToken = resolveToken(chain, position.baseToken)
      || resolveToken(chain, position.quoteToken)
      || null;
    const pool = position.pool ? String(position.pool).trim() : null;
    const tokenId = position.tokenId != null && String(position.tokenId).trim() !== ""
      ? String(position.tokenId).trim()
      : null;

    if (!pool && (!token0 || !token1)) {
      throw new Error(
        `positions[${index}] needs either "pool" or resolvable "token0"/"token1" symbols`,
      );
    }
    if (pool && !ADDRESS_RE.test(pool)) {
      throw new Error(`positions[${index}].pool is not a valid address: ${pool}`);
    }
    if (tokenId && !/^\d+$/.test(tokenId)) {
      throw new Error(`positions[${index}].tokenId must be an integer string`);
    }

    return {
      label: position.label || `position-${index + 1}`,
      chain: chain.key,
      chainId: chain.chainId,
      pool,
      tokenId,
      token0,
      token1,
      baseToken,
      fee: position.fee != null ? Number(position.fee) : null,
      amountUsd: position.amountUsd != null ? Number(position.amountUsd) : null,
      notes: position.notes || "",
    };
  });
}

function validate(config, { allowEmptyPositions = false } = {}) {
  const errors = [];
  if (!ADDRESS_RE.test(config.factory)) errors.push("factory address is invalid");
  if (!ADDRESS_RE.test(config.positionManager)) errors.push("positionManager address is invalid");
  for (const [chainKey, urls] of Object.entries(config.rpcByChain || {})) {
    if (!Array.isArray(urls) || urls.length === 0) {
      errors.push(`no RPC URL configured for ${chainKey}`);
      continue;
    }
    for (const url of urls) {
      if (!/^https?:\/\//i.test(url || "")) {
        errors.push(`${chainKey} RPC is not an http(s) URL: ${url}`);
      }
    }
  }
  if (!Array.isArray(config.rpcUrls) || config.rpcUrls.length === 0) {
    errors.push("no active RPC URL configured");
  }
  if (!/^\d+[mh]$/i.test(String(config.panda.timeframe))) {
    errors.push('panda.timeframe must look like "5m" or "1h"');
  }
  if (config.panda.confirmTicks < 1) errors.push("panda.confirmTicks must be >= 1");
  if (config.panda.rsiPeriod < 1) errors.push("panda.rsiPeriod must be >= 1");
  if (config.panda.rsiOverbought <= 0 || config.panda.rsiOverbought > 100) {
    errors.push("panda.rsiOverbought must be in (0, 100]");
  }
  if (config.panda.minCandles < 35) errors.push("panda.minCandles must be >= 35");
  if (config.panda.macdSlow + config.panda.macdSignal > config.panda.candles) {
    errors.push("panda.candles must be >= macdSlow + macdSignal");
  }
  if (!["any", "all"].includes(config.panda.confluenceMode)) {
    errors.push('panda.confluenceMode must be "any" or "all"');
  }
  if (!allowEmptyPositions && config.positions.length === 0 && !config.discovery.enabled) {
    errors.push("no positions configured and discovery is disabled");
  }
  if (config.discovery.enabled
    && !ADDRESS_RE.test(config.discovery.wallet || "")
    && !PRIVATE_KEY_RE.test(config.privateKey || "")) {
    config.warnings.push(
      "discovery is enabled but no discovery wallet or private key is configured yet",
    );
  }
  if (!config.dryRun) {
    if (!PRIVATE_KEY_RE.test(config.privateKey || "")) {
      errors.push("live mode requires WALLET_PRIVATE_KEY (or PRIVATE_KEY): 0x + 64 hex chars");
    }
    if (!config.liveAcknowledged) {
      errors.push("live mode requires I_UNDERSTAND_LIVE_TRADING=true");
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
  }
  return config;
}

/**
 * Build the runtime config.
 * @param {Object} [options]
 * @param {string} [options.chain]       override chain key
 * @param {string} [options.configPath]  explicit user-config JSON path
 * @param {boolean} [options.requirePositions] fail when nothing is configured
 */
export function loadConfig(options = {}) {
  const userConfigPath = options.configPath
    ? path.resolve(options.configPath)
    : path.join(__dirname, "user-config.json");
  const hasUserConfig = fs.existsSync(userConfigPath);
  const userConfig = hasUserConfig ? readJson(userConfigPath) : {};

  const chain = resolveChain(options.chain || process.env.CHAIN || userConfig.chain || DEFAULTS.chain);
  const merged = deepMerge(
    {
      ...DEFAULTS,
      positions: [...DEFAULTS.positions],
      chain: chain.key,
    },
    userConfig,
  );
  if (options.chain) merged.chain = resolveChain(options.chain).key;

  const envDryRun = process.env.DRY_RUN;
  const envShadowMode = process.env.SHADOW_MODE;
  const hasEnvDryRun = envDryRun != null && envDryRun !== "";
  const hasShadowMode = envShadowMode != null && envShadowMode !== "";
  const dryRun = hasEnvDryRun
    ? asBool(envDryRun, true)
    : hasShadowMode
      ? asBool(envShadowMode, true)
      : merged.dryRun !== false;
  const liveAcknowledged = asBool(process.env.I_UNDERSTAND_LIVE_TRADING, false);

  const warnings = [];
  if (hasEnvDryRun && hasShadowMode && asBool(envDryRun, true) !== asBool(envShadowMode, true)) {
    warnings.push("DRY_RUN and SHADOW_MODE disagree — DRY_RUN takes precedence.");
  }
  let effectiveDryRun = dryRun;
  if (!dryRun && !liveAcknowledged) {
    effectiveDryRun = true;
    warnings.push(
      "Live trading was requested but I_UNDERSTAND_LIVE_TRADING is not true — forcing shadow mode.",
    );
  }

  const rsiOverbought = Number(merged.panda.rsiOverbought);
  if (Number.isFinite(rsiOverbought) && (rsiOverbought < 70 || rsiOverbought > 80)) {
    warnings.push(
      `panda.rsiOverbought=${rsiOverbought} is outside the Evil Panda 70-80 band.`,
    );
  }

  // One independent RPC route per chain. .env lists are deduped and preserve
  // the priority order consumed by the FallbackProvider.
  const rpcByChain = buildRpcByChain(chain, merged);
  const rpcUrls = rpcByChain[chain.key];

  const config = {
    ...merged,
    chain: chain.key,
    chainConfig: chain,
    chainId: chain.chainId,
    factory: chain.factory,
    positionManager: chain.positionManager,
    quoterV2: chain.quoterV2,
    rpcUrl: rpcUrls[0],
    rpcUrls,
    rpcByChain,
    privateKey: String(
      process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || merged.privateKey || "",
    ).trim(),
    dryRun: effectiveDryRun,
    liveRequested: !dryRun,
    liveAcknowledged,
    pollIntervalMs: positiveInt(
      process.env.POLL_INTERVAL_MS ?? merged.pollIntervalMs,
      DEFAULTS.pollIntervalMs,
      3_000,
    ),
    panda: {
      ...merged.panda,
      enabled: asBool(merged.panda.enabled, true),
      timeframe: String(merged.panda.timeframe || "5m").toLowerCase(),
      candles: positiveInt(merged.panda.candles, 120, 35),
      cacheSec: positiveInt(merged.panda.cacheSec, 60, 0),
      confirmTicks: positiveInt(merged.panda.confirmTicks, 3, 1),
      rsiPeriod: positiveInt(merged.panda.rsiPeriod, 2, 1),
      rsiOverbought: Number(merged.panda.rsiOverbought ?? 80),
      bbPeriod: positiveInt(merged.panda.bbPeriod, 20, 2),
      bbStdDev: Number(merged.panda.bbStdDev ?? 2),
      macdFast: positiveInt(merged.panda.macdFast, 12, 1),
      macdSlow: positiveInt(merged.panda.macdSlow, 26, 2),
      macdSignal: positiveInt(merged.panda.macdSignal, 9, 1),
      minCandles: positiveInt(merged.panda.minCandles, 35, 35),
      confluenceMode: String(merged.panda.confluenceMode || "any").toLowerCase(),
      requireMacdShift: asBool(merged.panda.requireMacdShift, false),
    },
    priceFeed: {
      ...merged.priceFeed,
      bufferSize: positiveInt(merged.priceFeed.bufferSize, 50, 5),
      bufferMaxAgeMs: positiveInt(merged.priceFeed.bufferMaxAgeMs, 30 * 60_000, 60_000),
      staleSeriesMaxMs: positiveInt(merged.priceFeed.staleSeriesMaxMs, 30 * 60_000, 60_000),
      degradedCacheMs: positiveInt(merged.priceFeed.degradedCacheMs, 10_000, 1_000),
      geckoCooldownMs: positiveInt(merged.priceFeed.geckoCooldownMs, 60_000, 1_000),
      fetchTimeoutMs: positiveInt(merged.priceFeed.fetchTimeoutMs, 8_000, 1_000),
      resolvedTokenCacheMs: positiveInt(merged.priceFeed.resolvedTokenCacheMs, 10 * 60_000, 60_000),
    },
    positions: normalizePositions(merged.positions, chain),
    discovery: {
      ...merged.discovery,
      enabled: asBool(process.env.DISCOVERY_ENABLED ?? merged.discovery.enabled, true),
      wallet: String(
        process.env.DISCOVERY_WALLET
        || process.env.WALLET_ADDRESS
        || merged.discovery.wallet
        || "",
      ).trim(),
      maxPositions: positiveInt(
        process.env.DISCOVERY_MAX_POSITIONS ?? merged.discovery.maxPositions,
        10,
        1,
      ),
    },
    risk: {
      stopLossPct: Number(merged.risk.stopLossPct ?? -50),
      takeProfitPct: Number(merged.risk.takeProfitPct ?? 25),
    },
    exit: {
      ...merged.exit,
      burnAfterExit: asBool(merged.exit.burnAfterExit, true),
      slippageBps: positiveInt(merged.exit.slippageBps, 100, 0),
      deadlineSec: positiveInt(merged.exit.deadlineSec, 1_200, 60),
    },
    health: {
      enabled: asBool(process.env.HEALTH_ENABLED ?? merged.health.enabled, false),
      port: positiveInt(
        process.env.PORT ?? process.env.HEALTH_PORT ?? merged.health.port,
        3010,
        1,
      ),
    },
    telegram: {
      enabled: asBool(process.env.TELEGRAM_ENABLED ?? merged.telegram.enabled, false),
      commandsEnabled: asBool(
        process.env.TELEGRAM_COMMANDS_ENABLED ?? merged.telegram.commandsEnabled,
        true,
      ),
      botToken: String(process.env.TELEGRAM_BOT_TOKEN || merged.telegram.botToken || "").trim(),
      chatId: String(process.env.TELEGRAM_CHAT_ID || merged.telegram.chatId || "").trim(),
    },
    configPath: hasUserConfig ? userConfigPath : null,
    warnings,
  };

  if (!config.telegram.botToken || !config.telegram.chatId) {
    config.telegram.enabled = false;
    config.telegram.commandsEnabled = false;
  }

  return validate(config, {
    allowEmptyPositions: options.allowEmptyPositions === true
      || options.requirePositions === false,
  });
}

export function chainInfo(chainKey) {
  return resolveChain(chainKey);
}

/**
 * Build a chain-specific runtime config for a lazily created client. Keeps the
 * shared runtime settings but swaps chain metadata and its .env RPC route.
 */
export function chainRuntimeConfig(config, chainKey) {
  const chain = resolveChain(chainKey);
  const configured = config.rpcByChain?.[chain.key];
  const rpcUrls = [...new Set(
    (Array.isArray(configured) ? configured : chain.rpcUrls).filter(Boolean),
  )];
  return {
    ...config,
    chain: chain.key,
    chainConfig: chain,
    chainId: chain.chainId,
    factory: chain.factory,
    positionManager: chain.positionManager,
    quoterV2: chain.quoterV2,
    rpcUrl: rpcUrls[0],
    rpcUrls,
  };
}

export { DEFAULTS };

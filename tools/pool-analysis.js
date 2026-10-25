// ─── Multi-chain token & pool analysis ────────────────────────────────
// Resolves an EVM token/pool address across DexScreener, GeckoTerminal and
// GoPlus, enriches fee tiers from RPC when possible, and renders a risk report.

import { JsonRpcProvider } from "ethers";
import { escapeHtml, escapeHtmlAttr } from "./html.js";

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";
const GECKO_API = "https://api.geckoterminal.com/api/v2";
const GOPLUS_API = "https://api.gopluslabs.io/api/v1";
const FEE_SELECTOR = "0xddca3f43";
const MAX_POOLS = 6;

/** Supported analysis networks, including chains without a configured bot RPC. */
export const POOL_CHAINS = {
  ethereum: {
    key: "ethereum",
    name: "Ethereum",
    chainId: 1,
    gecko: "eth",
    dexScreener: "ethereum",
    explorer: "https://etherscan.io",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    uniswapChain: "ethereum",
    goplusChainId: 1,
  },
  bnb: {
    key: "bnb",
    name: "BNB Smart Chain",
    chainId: 56,
    gecko: "bsc",
    dexScreener: "bsc",
    explorer: "https://bscscan.com",
    rpcUrl: "https://bsc-rpc.publicnode.com",
    uniswapChain: "bnb",
    goplusChainId: 56,
  },
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    gecko: "base",
    dexScreener: "base",
    explorer: "https://basescan.org",
    rpcUrl: "https://mainnet.base.org",
    uniswapChain: "base",
    goplusChainId: 8453,
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum",
    chainId: 42161,
    gecko: "arbitrum",
    dexScreener: "arbitrum",
    explorer: "https://arbiscan.io",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    uniswapChain: "arbitrum",
    goplusChainId: 42161,
  },
  polygon: {
    key: "polygon",
    name: "Polygon",
    chainId: 137,
    gecko: "polygon_pos",
    dexScreener: "polygon",
    explorer: "https://polygonscan.com",
    rpcUrl: "https://polygon-rpc.com",
    uniswapChain: "polygon",
    goplusChainId: 137,
  },
  avalanche: {
    key: "avalanche",
    name: "Avalanche",
    chainId: 43114,
    gecko: "avax",
    dexScreener: "avalanche",
    explorer: "https://snowtrace.io",
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    uniswapChain: "avalanche",
    goplusChainId: 43114,
  },
  optimism: {
    key: "optimism",
    name: "Optimism",
    chainId: 10,
    gecko: "optimism",
    dexScreener: "optimism",
    explorer: "https://optimistic.etherscan.io",
    rpcUrl: "https://mainnet.optimism.io",
    uniswapChain: "optimism",
    goplusChainId: 10,
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    gecko: "robinhood",
    dexScreener: "robinhood",
    explorer: "https://robinhoodchain.blockscout.com",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    uniswapChain: null,
    goplusChainId: null,
  },
};

const CHAIN_BY_DEX = Object.fromEntries(
  Object.values(POOL_CHAINS).map((chain) => [chain.dexScreener, chain.key]),
);
const CHAIN_BY_GECKO = Object.fromEntries(
  Object.values(POOL_CHAINS).map((chain) => [chain.gecko, chain.key]),
);

export function isEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function num(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pct(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number <= 1 ? number * 100 : number;
}

function shortAddress(value) {
  const address = String(value || "");
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, fetchImpl, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseFeePercent(value) {
  const text = String(value || "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

function feeFromRaw(rawFee) {
  const fee = Number(rawFee);
  if (!Number.isFinite(fee) || fee < 0 || fee > 1_000_000) return null;
  return fee / 10_000;
}

function dexName(dexId) {
  const id = String(dexId || "").toLowerCase();
  if (id.includes("uniswap")) return "Uniswap v3";
  if (id.includes("pancake")) return "PancakeSwap v3";
  if (id.includes("aerodrome")) return "Aerodrome";
  if (id.includes("camelot")) return "Camelot";
  if (id.includes("quickswap")) return "QuickSwap";
  if (id.includes("traderjoe")) return "Trader Joe";
  if (id.includes("sushi")) return "SushiSwap";
  return dexId ? String(dexId) : "DEX";
}

function normalizeDexPair(pair) {
  const chainKey = CHAIN_BY_DEX[String(pair?.chainId || "").toLowerCase()];
  if (!chainKey || !pair?.pairAddress) return null;
  const buys = num(pair.txns?.h24?.buys) || 0;
  const sells = num(pair.txns?.h24?.sells) || 0;
  const rawFee = num(pair.feeTier ?? pair.fee);

  return {
    source: "dexscreener",
    chain: chainKey,
    dex: dexName(pair.dexId),
    dexId: String(pair.dexId || ""),
    pair: `${pair.baseToken?.symbol || "?"}/${pair.quoteToken?.symbol || "?"}`,
    pool: String(pair.pairAddress),
    feePercent: rawFee != null ? feeFromRaw(rawFee) : parseFeePercent(pair.name),
    tvl: num(pair.liquidity?.usd),
    volume24h: num(pair.volume?.h24),
    priceUsd: num(pair.priceUsd),
    priceNative: num(pair.priceNative),
    quotePriceUsd: num(pair.priceUsd) != null && num(pair.priceNative)
      ? num(pair.priceUsd) / num(pair.priceNative)
      : null,
    priceChange24h: num(pair.priceChange?.h24),
    marketCap: num(pair.marketCap),
    fdv: num(pair.fdv),
    buys,
    sells,
    txns24h: buys + sells,
    createdAt: num(pair.pairCreatedAt),
    base: {
      address: pair.baseToken?.address || null,
      symbol: pair.baseToken?.symbol || null,
      name: pair.baseToken?.name || null,
    },
    quote: {
      address: pair.quoteToken?.address || null,
      symbol: pair.quoteToken?.symbol || null,
      name: pair.quoteToken?.name || null,
    },
    labels: Array.isArray(pair.labels) ? pair.labels : [],
    chartUrl: pair.url || null,
  };
}

function pairMatches(pair, address) {
  const target = address.toLowerCase();
  return [pair.pairAddress, pair.baseToken?.address, pair.quoteToken?.address]
    .some((value) => String(value || "").toLowerCase() === target);
}

async function fetchDexPools(address, fetchImpl, timeoutMs) {
  const endpoints = [
    `${DEXSCREENER_API}/tokens/${encodeURIComponent(address)}`,
    `${DEXSCREENER_API}/search?q=${encodeURIComponent(address)}`,
  ];
  const pairs = [];

  for (const endpoint of endpoints) {
    try {
      const payload = await fetchJson(endpoint, fetchImpl, timeoutMs);
      const found = Array.isArray(payload?.pairs) ? payload.pairs : [];
      pairs.push(...found.filter((pair) => pairMatches(pair, address)));
      if (pairs.length > 0) break;
    } catch {
      // Try the next endpoint.
    }
  }

  const seen = new Set();
  return pairs
    .map(normalizeDexPair)
    .filter(Boolean)
    .filter((pool) => {
      const key = `${pool.chain}:${pool.pool.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
}

function geckoIdPart(value) {
  const id = String(value || "");
  for (const chain of Object.values(POOL_CHAINS)) {
    const prefix = `${chain.gecko}_`;
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  const separator = id.indexOf("_");
  return separator >= 0 ? id.slice(separator + 1) : "";
}

function geckoChainKey(id) {
  const text = String(id || "");
  for (const chain of Object.values(POOL_CHAINS)) {
    if (text.startsWith(`${chain.gecko}_`)) return chain.key;
  }
  return CHAIN_BY_GECKO[text.split("_")[0]] || null;
}

function normalizeGeckoPool(item) {
  const chainKey = geckoChainKey(item?.id);
  if (!chainKey) return null;

  const attrs = item.attributes || {};
  const nameParts = String(attrs.name || "").split("/");
  const baseSymbol = nameParts[0]?.trim() || null;
  const quoteSymbol = nameParts[1]?.trim().split(/\s+/)[0] || null;
  const buys = num(attrs.transactions?.h24?.buys) || 0;
  const sells = num(attrs.transactions?.h24?.sells) || 0;
  const poolAddress = attrs.address || geckoIdPart(item.id);
  if (!poolAddress) return null;

  return {
    source: "geckoterminal",
    chain: chainKey,
    dex: dexName(item.relationships?.dex?.data?.id),
    dexId: String(item.relationships?.dex?.data?.id || ""),
    pair: `${baseSymbol || "?"}/${quoteSymbol || "?"}`,
    pool: poolAddress,
    feePercent: parseFeePercent(attrs.name),
    tvl: num(attrs.reserve_in_usd),
    volume24h: num(attrs.volume_usd?.h24),
    priceUsd: num(attrs.base_token_price_usd),
    priceNative: null,
    quotePriceUsd: num(attrs.quote_token_price_usd),
    priceChange24h: num(attrs.price_change_percentage?.h24),
    marketCap: num(attrs.market_cap_usd),
    fdv: num(attrs.fdv_usd),
    buys,
    sells,
    txns24h: buys + sells,
    createdAt: attrs.pool_created_at ? Date.parse(attrs.pool_created_at) : null,
    base: {
      address: geckoIdPart(item.relationships?.base_token?.data?.id) || null,
      symbol: baseSymbol,
      name: null,
    },
    quote: {
      address: geckoIdPart(item.relationships?.quote_token?.data?.id) || null,
      symbol: quoteSymbol,
      name: null,
    },
    labels: [],
    chartUrl: `https://www.geckoterminal.com/${POOL_CHAINS[chainKey].gecko}/pools/${poolAddress}`,
  };
}

async function fetchGeckoPools(address, fetchImpl, timeoutMs) {
  const pools = [];
  try {
    const payload = await fetchJson(
      `${GECKO_API}/search/pools?query=${encodeURIComponent(address)}&page=1`,
      fetchImpl,
      timeoutMs,
    );
    const items = Array.isArray(payload?.data) ? payload.data : [];
    for (const item of items) {
      const target = address.toLowerCase();
      const base = geckoIdPart(item.relationships?.base_token?.data?.id).toLowerCase();
      const quote = geckoIdPart(item.relationships?.quote_token?.data?.id).toLowerCase();
      const poolAddress = String(item.attributes?.address || "").toLowerCase();
      if (target !== poolAddress && target !== base && target !== quote) continue;
      const pool = normalizeGeckoPool(item);
      if (pool) pools.push(pool);
    }
  } catch {
    // Fall through to per-network lookup.
  }

  if (pools.length === 0) {
    const results = await Promise.allSettled(
      Object.values(POOL_CHAINS).map(async (chain) => {
        const payload = await fetchJson(
          `${GECKO_API}/networks/${chain.gecko}/pools/${encodeURIComponent(address)}`,
          fetchImpl,
          timeoutMs,
        );
        const pool = normalizeGeckoPool(payload?.data);
        return pool && pool.pool.toLowerCase() === address.toLowerCase() ? pool : null;
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) pools.push(result.value);
    }
  }

  const seen = new Set();
  return pools
    .filter((pool) => {
      const key = `${pool.chain}:${pool.pool.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
}

function explorerUrl(pool) {
  return `${POOL_CHAINS[pool.chain].explorer}/address/${pool.pool}`;
}

function dexPoolUrl(pool) {
  const chain = POOL_CHAINS[pool.chain];
  const id = String(pool.dexId || "").toLowerCase();
  if (id.includes("uniswap") && chain.uniswapChain) {
    return `https://app.uniswap.org/explore/pools/${chain.uniswapChain}/${pool.pool}`;
  }
  if (id.includes("pancake")) {
    return `https://pancakeswap.finance/info/v3/pairs/${pool.pool}`;
  }
  return null;
}

function boolFlag(value) {
  if (value == null || value === "") return null;
  return String(value) === "1" || value === true;
}

async function fetchGoPlus(tokenAddress, chainKey, fetchImpl, timeoutMs) {
  const chain = POOL_CHAINS[chainKey];
  if (!tokenAddress || !chain?.goplusChainId) return null;

  const payload = await fetchJson(
    `${GOPLUS_API}/token_security/${chain.goplusChainId}`
    + `?contract_addresses=${encodeURIComponent(tokenAddress)}`,
    fetchImpl,
    timeoutMs,
  );
  const entry = payload?.result?.[tokenAddress.toLowerCase()]
    || Object.values(payload?.result || {})[0];
  if (!entry) return null;

  const holders = Array.isArray(entry.holders) ? entry.holders : [];
  const top10Pct = holders.slice(0, 10)
    .reduce((sum, holder) => sum + (pct(holder.percent) || 0), 0);

  return {
    holderCount: num(entry.holder_count),
    top10Pct: holders.length ? Math.min(100, top10Pct) : null,
    creatorPct: pct(entry.creator_percent),
    topHolders: holders.slice(0, 10).map((holder) => ({
      address: holder.address,
      percent: pct(holder.percent),
      tag: holder.tag || null,
      isContract: boolFlag(holder.is_contract),
    })),
    flags: {
      honeypot: boolFlag(entry.is_honeypot),
      mintable: boolFlag(entry.is_mintable),
      proxy: boolFlag(entry.is_proxy),
      openSource: boolFlag(entry.is_open_source),
      hiddenOwner: boolFlag(entry.hidden_owner),
      canTakeBackOwnership: boolFlag(entry.can_take_back_ownership),
      ownerChangeBalance: boolFlag(entry.owner_change_balance),
      buyTax: pct(entry.buy_tax),
      sellTax: pct(entry.sell_tax),
    },
  };
}

async function readFeeOnChain(pool, { config, router, enableRpcFallback, timeoutMs }) {
  if (!enableRpcFallback) return null;
  const chain = POOL_CHAINS[pool.chain];
  try {
    if (config?.rpcByChain?.[pool.chain] && router) {
      const client = router.get(pool.chain);
      const state = await withTimeout(
        client.getPoolState(pool.pool),
        timeoutMs,
        "pool fee",
      );
      return feeFromRaw(state.fee);
    }
    if (!chain?.rpcUrl) return null;
    const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    try {
      const data = await withTimeout(
        provider.call({ to: pool.pool, data: FEE_SELECTOR }),
        5_000,
        "pool fee",
      );
      return data && data !== "0x" ? feeFromRaw(BigInt(data)) : null;
    } finally {
      provider.destroy();
    }
  } catch {
    return null;
  }
}

async function detectChainsByCode(address, { config, router, enableRpcFallback, timeoutMs }) {
  if (!enableRpcFallback) return [];
  const results = await Promise.allSettled(
    Object.values(POOL_CHAINS).map(async (chain) => {
      let provider = null;
      try {
        if (config?.rpcByChain?.[chain.key] && router) {
          const client = router.get(chain.key);
          const code = await withTimeout(client.provider.getCode(address), timeoutMs, "chain code");
          return code && code !== "0x" ? chain.key : null;
        }
        if (!chain.rpcUrl) return null;
        provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
        const code = await withTimeout(provider.getCode(address), timeoutMs, "chain code");
        return code && code !== "0x" ? chain.key : null;
      } catch {
        return null;
      } finally {
        provider?.destroy();
      }
    }),
  );
  return [...new Set(results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value))];
}

const STABLE_SYMBOLS = new Set([
  "USDC", "USDC.E", "USDT", "DAI", "BUSD", "FDUSD", "TUSD", "USDD", "USDG",
]);

function priceForToken(pool, token) {
  if (!pool || !token) return pool?.priceUsd ?? null;
  const address = String(token.address || "").toLowerCase();
  if (String(pool.base?.address || "").toLowerCase() === address) return pool.priceUsd;
  if (String(pool.quote?.address || "").toLowerCase() === address) return pool.quotePriceUsd;
  return pool.priceUsd;
}

function pickTargetToken(input, pool) {
  if (!pool) return null;
  const target = input.toLowerCase();
  if (String(pool.base.address || "").toLowerCase() === target) return pool.base;
  if (String(pool.quote.address || "").toLowerCase() === target) return pool.quote;

  const baseStable = STABLE_SYMBOLS.has(String(pool.base.symbol || "").toUpperCase());
  const quoteStable = STABLE_SYMBOLS.has(String(pool.quote.symbol || "").toUpperCase());
  if (baseStable && !quoteStable) return pool.quote;
  return pool.base;
}

export function buildNarrative(primary, holders = null) {
  const tvl = num(primary?.tvl);
  const volume = num(primary?.volume24h);
  const fdv = num(primary?.fdv);
  const volumeTvlPct = tvl && volume != null ? (volume / tvl) * 100 : null;
  const tvlToFdvPct = tvl != null && fdv ? (tvl / fdv) * 100 : null;
  const top10 = num(holders?.top10Pct);
  const flags = holders?.flags || null;
  const reasons = [];
  let riskStatus = "LOW";

  const bump = (level, reason) => {
    reasons.push(reason);
    if (level === "HIGH") riskStatus = "HIGH";
    else if (level === "MEDIUM" && riskStatus !== "HIGH") riskStatus = "MEDIUM";
  };

  if (flags?.honeypot === true) bump("HIGH", "GoPlus reports a honeypot flag");
  if (flags?.hiddenOwner === true) bump("HIGH", "Hidden owner privilege detected");
  if (flags?.canTakeBackOwnership === true) bump("HIGH", "Ownership can be taken back");
  if (flags?.buyTax != null && flags.buyTax > 10) bump("HIGH", `High buy tax (${flags.buyTax.toFixed(1)}%)`);
  else if (flags?.buyTax != null && flags.buyTax > 5) bump("MEDIUM", `Elevated buy tax (${flags.buyTax.toFixed(1)}%)`);
  if (flags?.sellTax != null && flags.sellTax > 10) bump("HIGH", `High sell tax (${flags.sellTax.toFixed(1)}%)`);
  else if (flags?.sellTax != null && flags.sellTax > 5) bump("MEDIUM", `Elevated sell tax (${flags.sellTax.toFixed(1)}%)`);
  if (flags?.proxy === true) bump("MEDIUM", "Token contract is upgradeable/proxy");
  if (flags?.ownerChangeBalance === true) bump("MEDIUM", "Owner can change holder balances");
  if (top10 != null && top10 >= 70) bump("HIGH", `Top 10 holders control ${top10.toFixed(1)}%`);
  else if (top10 != null && top10 >= 40) bump("MEDIUM", `Top 10 holders control ${top10.toFixed(1)}%`);
  if (tvl != null && tvl < 25_000) bump("HIGH", "Very thin liquidity (<$25k)");
  else if (tvl != null && tvl < 100_000) bump("MEDIUM", "Thin liquidity (<$100k)");
  if (volumeTvlPct != null && volumeTvlPct < 5) bump("MEDIUM", "Low 24h volume relative to TVL");
  if (tvlToFdvPct != null && tvlToFdvPct < 0.5) {
    bump("MEDIUM", "Low TVL relative to FDV");
  }

  let volumeHealth;
  if (volumeTvlPct == null) volumeHealth = "24h turnover unavailable.";
  else if (volumeTvlPct >= 300) {
    volumeHealth = `Extremely high Vol/TVL (${volumeTvlPct.toFixed(1)}%) — very active, `
      + "speculative trading; fee income may be high but churn risk is elevated.";
  } else if (volumeTvlPct >= 100) {
    volumeHealth = `High Vol/TVL ratio (${volumeTvlPct.toFixed(1)}%) indicating active trading.`;
  } else if (volumeTvlPct >= 25) {
    volumeHealth = `Healthy turnover (${volumeTvlPct.toFixed(1)}%) relative to liquidity.`;
  } else if (volumeTvlPct >= 5) {
    volumeHealth = `Moderate turnover (${volumeTvlPct.toFixed(1)}%).`;
  } else {
    volumeHealth = `Low turnover (${volumeTvlPct.toFixed(1)}%) — volume is thin relative to TVL.`;
  }

  let liquidityNote;
  if (tvl == null) liquidityNote = "TVL unavailable.";
  else if (tvl < 25_000) liquidityNote = "Very thin liquidity — elevated slippage and exit risk.";
  else if (tvl < 100_000) liquidityNote = "Thin liquidity — size positions carefully.";
  else if (tvl < 1_000_000) liquidityNote = "Moderate liquidity depth.";
  else liquidityNote = "Deep liquidity.";
  if (tvlToFdvPct != null) {
    liquidityNote += tvlToFdvPct < 0.5
      ? ` TVL is only ${tvlToFdvPct.toFixed(2)}% of FDV.`
      : tvlToFdvPct > 10
        ? ` TVL is ${tvlToFdvPct.toFixed(1)}% of FDV.`
        : "";
  }

  let holderNote;
  if (top10 == null) holderNote = "Holder concentration unavailable.";
  else if (top10 >= 70) holderNote = `Top 10 wallets hold ${top10.toFixed(1)}% — high concentration.`;
  else if (top10 >= 40) holderNote = `Top 10 wallets hold ${top10.toFixed(1)}% — moderate concentration.`;
  else holderNote = `Top 10 wallets hold ${top10.toFixed(1)}% — relatively dispersed.`;
  if (holders?.creatorPct != null) {
    holderNote += ` Creator holds ${holders.creatorPct.toFixed(2)}%.`;
  }

  const buys = num(primary?.buys) || 0;
  const sells = num(primary?.sells) || 0;
  const txns = num(primary?.txns24h) || 0;
  const avgTrade = txns > 0 && volume != null ? volume / txns : null;
  let activityNote = txns > 0
    ? `${txns.toLocaleString()} txns/24h (${buys.toLocaleString()} buys / ${sells.toLocaleString()} sells)`
    : "No 24h transaction data.";
  if (txns >= 1_000 && avgTrade != null && avgTrade < 100) {
    activityNote += " — very high count with small average trades suggests bot/sniper activity.";
  } else if (buys + sells > 0) {
    const ratio = sells > 0 ? buys / sells : buys > 0 ? Infinity : 1;
    if (ratio > 1.5) activityNote += " — buy-side dominant.";
    else if (ratio < 0.67) activityNote += " — sell-side dominant.";
    else activityNote += " — balanced buy/sell flow.";
  }

  let safetyNote;
  if (!flags) safetyNote = "Token tax/holder safety metadata unavailable (GoPlus).";
  else {
    const parts = [
      `honeypot: ${flags.honeypot == null ? "n/a" : flags.honeypot ? "yes" : "no"}`,
      `buy tax: ${flags.buyTax == null ? "n/a" : `${flags.buyTax.toFixed(1)}%`}`,
      `sell tax: ${flags.sellTax == null ? "n/a" : `${flags.sellTax.toFixed(1)}%`}`,
      `mintable: ${flags.mintable == null ? "n/a" : flags.mintable ? "yes" : "no"}`,
      `proxy: ${flags.proxy == null ? "n/a" : flags.proxy ? "yes" : "no"}`,
      `open source: ${flags.openSource == null ? "n/a" : flags.openSource ? "yes" : "no"}`,
    ];
    safetyNote = parts.join(" | ");
  }

  if (reasons.length === 0) reasons.push("No major automated risk flags detected.");

  return {
    volumeTvlPct,
    tvlToFdvPct,
    volumeHealth,
    liquidityNote,
    holderNote,
    activityNote,
    safetyNote,
    riskStatus,
    reasons,
  };
}

/**
 * Resolve an EVM token or pool address across chains and build a risk report.
 * `enableRpcFallback=false` keeps tests/offline calls API-only.
 */
export async function analyzePoolAddress({
  address,
  config = {},
  router = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  enableRpcFallback = true,
} = {}) {
  const input = String(address || "").trim();
  if (!isEvmAddress(input)) {
    return {
      address: input,
      error: "Invalid EVM contract address. Expected 0x followed by 40 hex characters.",
    };
  }

  const errors = [];
  let pools = [];
  try {
    pools = await fetchDexPools(input, fetchImpl, timeoutMs);
  } catch (error) {
    errors.push(`DexScreener: ${error.message || String(error)}`);
  }
  if (pools.length === 0) {
    try {
      pools = await fetchGeckoPools(input, fetchImpl, timeoutMs);
    } catch (error) {
      errors.push(`GeckoTerminal: ${error.message || String(error)}`);
    }
  }

  if (pools.length === 0) {
    const detected = await detectChainsByCode(input, {
      config,
      router,
      enableRpcFallback,
      timeoutMs,
    });
    if (detected.length === 0) {
      return {
        address: input,
        pools: [],
        errors,
        error: "No supported EVM chain or active DEX pool found for this address. "
          + "Check the contract address and configured networks.",
      };
    }
    const chain = POOL_CHAINS[detected[0]];
    return {
      address: input,
      chain: chain.key,
      chainName: chain.name,
      chainId: chain.chainId,
      token: null,
      pools: [],
      primary: null,
      holders: null,
      narrative: buildNarrative(null, null),
      errors,
      note: `Contract found on ${chain.name}, but no active DEX pool was returned by `
        + "DexScreener or GeckoTerminal.",
    };
  }

  pools = pools.slice(0, MAX_POOLS);
  const primary = pools[0];
  const chain = POOL_CHAINS[primary.chain];
  const token = pickTargetToken(input, primary);

  await Promise.all(pools.slice(0, 3).map(async (pool) => {
    if (pool.feePercent == null) {
      pool.feePercent = await readFeeOnChain(pool, {
        config,
        router,
        enableRpcFallback,
        timeoutMs,
      });
    }
  }));

  let holders = null;
  if (token?.address) {
    try {
      holders = await fetchGoPlus(token.address, primary.chain, fetchImpl, timeoutMs);
    } catch (error) {
      errors.push(`GoPlus: ${error.message || String(error)}`);
    }
  }

  return {
    address: input,
    chain: primary.chain,
    chainName: chain.name,
    chainId: chain.chainId,
    token,
    priceUsd: priceForToken(primary, token),
    pools,
    primary,
    holders,
    narrative: buildNarrative(primary, holders),
    errors,
  };
}

function fmtMoney(value) {
  const number = num(value);
  if (number == null) return "n/a";
  const abs = Math.abs(number);
  if (abs >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(number / 1_000).toFixed(2)}K`;
  return `$${number.toFixed(2)}`;
}

function fmtPrice(value) {
  const number = num(value);
  if (number == null) return "n/a";
  if (Math.abs(number) < 0.0001) return `$${number.toFixed(8)}`;
  if (Math.abs(number) < 0.01) return `$${number.toFixed(6)}`;
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}

function fmtChange(value) {
  const number = num(value);
  if (number == null) return "n/a";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function fmtRatio(value) {
  const number = num(value);
  return number == null ? "n/a" : `${number.toFixed(1)}%`;
}

function fmtFee(value) {
  const number = num(value);
  if (number == null) return "n/a";
  return `${Number(number.toFixed(4))}%`;
}

export function formatPoolAnalysis(analysis = {}) {
  const lines = ["<b>Pool &amp; Token Analysis</b>"];

  if (analysis.error) {
    lines.push(`Address: <code>${escapeHtml(analysis.address || "n/a")}</code>`);
    lines.push("");
    lines.push(`❌ ${escapeHtml(analysis.error)}`);
    if (analysis.errors?.length) {
      lines.push("", `<i>Data warnings: ${analysis.errors.map(escapeHtml).join("; ")}</i>`);
    }
    return lines.join("\n");
  }

  lines.push(`Address: <code>${escapeHtml(analysis.address)}</code>`);
  if (analysis.chainName) {
    lines.push(`Chain: <b>${escapeHtml(analysis.chainName)}</b> (${escapeHtml(analysis.chainId)})`);
  }
  const token = analysis.token;
  if (token) {
    lines.push(
      `Token: <b>${escapeHtml(token.symbol || "?")}</b>`
      + `${token.name ? ` — ${escapeHtml(token.name)}` : ""}`,
    );
    if (token.address) lines.push(`Token contract: <code>${escapeHtml(token.address)}</code>`);
  }

  if (analysis.note) {
    lines.push("", `⚠️ ${escapeHtml(analysis.note)}`);
  }

  lines.push("", `<b>Liquidity &amp; Pools</b> (${analysis.pools?.length || 0} found)`);
  if (!analysis.pools?.length) {
    lines.push("No active DEX pools found.");
    if (analysis.errors?.length) {
      lines.push("", `<i>Data warnings: ${analysis.errors.map(escapeHtml).join("; ")}</i>`);
    }
    return lines.join("\n");
  }

  for (const [index, pool] of (analysis.pools || []).entries()) {
    const links = [];
    if (pool.chartUrl) {
      links.push(`<a href="${escapeHtmlAttr(pool.chartUrl)}">Chart</a>`);
    }
    const dexUrl = dexPoolUrl(pool);
    if (dexUrl) links.push(`<a href="${escapeHtmlAttr(dexUrl)}">DEX</a>`);
    links.push(`<a href="${escapeHtmlAttr(explorerUrl(pool))}">Explorer</a>`);

    lines.push(`${index + 1}. <b>${escapeHtml(pool.pair)}</b> — ${escapeHtml(pool.dex)}`);
    lines.push(
      `   Pool <code>${escapeHtml(pool.pool)}</code> | fee ${fmtFee(pool.feePercent)}`,
    );
    lines.push(
      `   TVL ${fmtMoney(pool.tvl)} | Vol24h ${fmtMoney(pool.volume24h)} | `
      + `Vol/TVL ${fmtRatio(pool.tvl && pool.volume24h != null
        ? (pool.volume24h / pool.tvl) * 100
        : null)}`,
    );
    lines.push(
      `   Price ${fmtPrice(priceForToken(pool, token))} | `
      + `24h ${fmtChange(pool.priceChange24h)} | `
      + `MC ${fmtMoney(pool.marketCap)} | FDV ${fmtMoney(pool.fdv)}`,
    );
    lines.push(`   ${links.join(" | ")}`);
  }

  const holders = analysis.holders;
  const narrative = analysis.narrative || buildNarrative(analysis.primary, holders);
  lines.push("", "<b>Holders &amp; Safety</b>");
  lines.push(
    `Holders: ${holders?.holderCount == null ? "n/a" : holders.holderCount.toLocaleString()} | `
    + `Top10: ${fmtRatio(holders?.top10Pct)} | `
    + `Creator: ${fmtRatio(holders?.creatorPct)}`,
  );
  if (holders?.topHolders?.length) {
    const top = holders.topHolders.slice(0, 3)
      .map((holder) => `<code>${escapeHtml(shortAddress(holder.address))}</code> ${fmtRatio(holder.percent)}`)
      .join(", ");
    lines.push(`Top holders: ${top}`);
  }
  lines.push(`Safety: ${escapeHtml(narrative.safetyNote)}`);
  lines.push(`Activity: ${escapeHtml(narrative.activityNote)}`);

  lines.push("", "<b>Narrative &amp; Market Insight</b>");
  lines.push(`Volume health: ${escapeHtml(narrative.volumeHealth)}`);
  lines.push(`Liquidity depth: ${escapeHtml(narrative.liquidityNote)}`);
  lines.push(`Holder profile: ${escapeHtml(narrative.holderNote)}`);
  lines.push(
    `Risk: <b>${escapeHtml(narrative.riskStatus)}</b> — `
    + `${escapeHtml(narrative.reasons.join("; "))}`,
  );

  if (analysis.errors?.length) {
    lines.push("", `<i>Data warnings: ${analysis.errors.map(escapeHtml).join("; ")}</i>`);
  }
  return lines.join("\n");
}







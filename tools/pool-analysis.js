// ─── Multi-chain token & pool analysis ────────────────────────────────
// Resolves an EVM token/pool address across DexScreener, GeckoTerminal and
// GoPlus, enriches fee tiers from RPC when possible, and renders a risk report.

import { JsonRpcProvider } from "ethers";
import { escapeHtml, escapeHtmlAttr } from "./html.js";

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";
const GECKO_API = "https://api.geckoterminal.com/api/v2";
const GOPLUS_API = "https://api.gopluslabs.io/api/v1";
const FEE_SELECTOR = "0xddca3f43";
const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";
const DECIMALS_SELECTOR = "0x313ce567";
const SYMBOL_SELECTOR = "0x95d89b41";
const MAX_POOLS = 10;
const DETAILED_POOLS = 3;

// ─── Indexer / subgraph endpoints ────────────────────────────────────
// Secondary source for pool metadata when DexScreener/GeckoTerminal omit the
// Uniswap v3 fee tier (common on newer EVM chains such as Robinhood Chain).
const INDEXER_PROTOCOLS = new Set([
  "auto",
  "graphql",
  "subgraph",
  "envio",
  "defined",
  "rest",
  "generic",
  "api",
]);

const INDEXER_GRAPHQL_QUERY = `
query MorpheusPoolMetadata($id: ID!) {
  pool(id: $id) {
    id
    feeTier
    tickSpacing
    token0 { id symbol name }
    token1 { id symbol name }
  }
}`.trim();

const INDEXER_GRAPHQL_MIN_QUERY = `
query MorpheusPoolFee($id: ID!) {
  pool(id: $id) {
    id
    feeTier
    tickSpacing
    token0 { id symbol }
    token1 { id symbol }
  }
}`.trim();

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

/**
 * Normalize any EVM address-like value into a strict 20-byte contract address.
 * Accepts plain 20-byte addresses, 32-byte ABI words/topics (left padded) and
 * bytes32 pool ids, returning `0x` + 40 hex characters or null.
 */
export function normalizeEvmAddress(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const hex = raw.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length === 40) return `0x${hex}`;
  if (hex.length === 64) {
    const head = hex.slice(0, 24);
    // ABI-encoded addresses / topics are left padded with zeros.
    const body = /^0+$/.test(head) ? hex.slice(24) : hex.slice(-40);
    return `0x${body}`;
  }
  if (hex.length > 40) return `0x${hex.slice(-40)}`;
  return null;
}

function sameAddress(a, b) {
  const left = normalizeEvmAddress(a);
  const right = normalizeEvmAddress(b);
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function sortTokenAddresses(a, b) {
  const left = normalizeEvmAddress(a);
  const right = normalizeEvmAddress(b);
  if (!left || !right) return [left || null, right || null];
  return left.toLowerCase() <= right.toLowerCase() ? [left, right] : [right, left];
}

function decodeAddressWord(data) {
  const hex = String(data || "").replace(/^0x/i, "");
  if (hex.length !== 64) return null;
  return normalizeEvmAddress(hex);
}

function decodeUint(data) {
  const hex = String(data || "").replace(/^0x/i, "");
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    return BigInt(`0x${hex}`);
  } catch {
    return null;
  }
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
  const text = String(value ?? "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

/**
 * Convert an API fee field into a human percentage.
 * Uniswap-style fee tiers are hundredths of a basis point:
 * 100 -> 0.01%, 500 -> 0.05%, 3000 -> 0.3%, 10000 -> 1%.
 * Fractions (0.003) and pre-formatted percentages (0.3) are also accepted.
 */
function feeFromRaw(rawFee) {
  if (rawFee == null || rawFee === "") return null;
  if (typeof rawFee === "string") {
    const parsed = parseFeePercent(rawFee);
    if (parsed != null) return parsed;
    if (!/^-?\d+(?:\.\d+)?$/.test(rawFee.trim())) return null;
  }
  const fee = Number(rawFee);
  if (!Number.isFinite(fee) || fee < 0) return null;
  if (fee === 0) return 0;
  if (Number.isInteger(fee)) {
    return fee > 1_000_000 ? null : Number((fee / 10_000).toFixed(6));
  }
  if (fee < 0.01) return Number((fee * 100).toFixed(6));
  if (fee > 1_000_000) return null;
  return Number(fee.toFixed(6));
}

/** First parseable fee candidate (string percent, raw tier or fraction). */
function resolveFeePercent(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const fee = feeFromRaw(candidate);
    if (fee != null) return fee;
  }
  return null;
}

/** Canonical Uniswap v3 tick spacing for the standard fee tiers. */
const FEE_TIER_TICK_SPACING = Object.freeze({
  100: 1,
  500: 10,
  3_000: 60,
  10_000: 200,
});

/**
 * Normalize one raw uint24 fee value (from `fee()` or `slot0`/state) into the
 * complete metadata shape used by the screening table.
 */
function feeMetadataFromRaw(rawFee) {
  if (rawFee == null || rawFee === "") return null;
  const feeTier = Number(rawFee);
  if (!Number.isInteger(feeTier) || feeTier <= 0 || feeTier > 1_000_000) return null;
  return {
    feeTier,
    feePercent: feeFromRaw(feeTier),
    tickSpacing: FEE_TIER_TICK_SPACING[feeTier] ?? null,
    source: "rpc",
  };
}

// ─── Indexer service (Subgraph / Defined.fi / Envio) ─────────────────
// Resolves the canonical Uniswap v3 fee tier (uint24) and tick spacing from a
// Pool/Factory entity. Endpoints are configured through `INDEXER_API_URL`,
// a per-chain `SUBGRAPH_URL_<chainId>` (e.g. SUBGRAPH_URL_4663) or
// `config.indexer.byChain`. GraphQL first, REST as a compatibility fallback.

/** Canonical Uniswap v3 fee tiers keyed by raw uint24 value. */
export const UNISWAP_FEE_TIERS = Object.freeze({
  100: "0.01%",
  500: "0.05%",
  3000: "0.3%",
  10000: "1.0%",
});

function formatFeeLabel(percent) {
  const canonical = {
    0.01: "0.01%",
    0.05: "0.05%",
    0.3: "0.3%",
    1: "1.0%",
  }[Number(percent.toFixed(6))];
  return canonical || `${Number(percent.toFixed(4))}%`;
}

/**
 * Convert a raw fee tier (100, 500, 3000, 10000), a fraction (0.0005) or a
 * pre-formatted percentage ("0.05%") into the user-facing tier label.
 */
export function feeTierLabel(value) {
  if (value == null || value === "") return null;

  let number;
  if (typeof value === "string") {
    const parsed = parseFeePercent(value);
    if (parsed != null) return formatFeeLabel(parsed);
    if (!/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
    number = Number(value);
  } else {
    number = Number(value);
  }
  if (!Number.isFinite(number) || number < 0) return null;

  // Raw uint24 tiers are integers; known tiers map directly.
  if (Number.isInteger(number) && UNISWAP_FEE_TIERS[number]) {
    return UNISWAP_FEE_TIERS[number];
  }
  // Already a percentage, or a fraction such as 0.0005 -> 0.05%.
  return formatFeeLabel(number < 0.01 ? number * 100 : number);
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve the indexer settings that apply to one supported chain. */
function indexerForChain(config, chainKey) {
  const chain = POOL_CHAINS[chainKey];
  if (!chain) return null;
  const settings = isRecord(config?.indexer) ? config.indexer : {};
  if (settings.enabled === false) return null;

  const byChain = isRecord(settings.byChain) ? settings.byChain : {};
  const chainSpecific = [
    byChain[chainKey],
    byChain[String(chain.chainId)],
    process.env?.[`SUBGRAPH_URL_${chain.chainId}`],
    process.env?.[`INDEXER_API_URL_${chain.chainId}`],
  ].map((value) => String(value || "").trim()).find(Boolean);

  const url = chainSpecific
    || String(settings.url || "").trim()
    || String(process.env?.INDEXER_API_URL || "").trim();
  if (!url) return null;

  const requestedType = String(
    settings.type || process.env?.INDEXER_API_TYPE || "auto",
  ).trim().toLowerCase();
  const type = INDEXER_PROTOCOLS.has(requestedType) ? requestedType : "auto";
  const inferredType = type !== "auto"
    ? type
    : /defined/i.test(url)
      ? "defined"
      : /envio/i.test(url)
        ? "envio"
        : "subgraph";

  return {
    url,
    type,
    source: inferredType === "rest" ? "indexer" : inferredType,
    apiKey: String(settings.apiKey || process.env?.INDEXER_API_KEY || "").trim(),
    timeoutMs: num(settings.timeoutMs) > 0 ? num(settings.timeoutMs) : 8_000,
    chainKey,
  };
}

function indexerHeaders(indexer, { json = false } = {}) {
  const headers = { accept: "application/json" };
  if (json) headers["content-type"] = "application/json";
  if (indexer.apiKey) {
    headers.authorization = `Bearer ${indexer.apiKey}`;
    headers["x-api-key"] = indexer.apiKey;
  }
  return headers;
}

async function indexerRequest(url, options, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Protocols to try for an endpoint, in priority order. */
function indexerProtocolOrder(indexer) {
  if (indexer.type === "graphql" || indexer.type === "subgraph" || indexer.type === "envio") {
    return ["graphql"];
  }
  if (indexer.type === "rest" || indexer.type === "defined") return ["rest", "graphql"];
  return ["graphql", "rest"];
}

function normalizeIndexerToken(value, symbol = null) {
  if (isRecord(value)) {
    return {
      address: normalizeEvmAddress(value.id || value.address || value.tokenAddress),
      symbol: value.symbol || value.tokenSymbol || symbol || null,
      name: value.name || null,
    };
  }
  return {
    address: normalizeEvmAddress(value),
    symbol: symbol || null,
    name: null,
  };
}

/** Pick the entity carrying fee/token metadata from a GraphQL/REST payload. */
function pickIndexerEntity(payload) {
  const candidates = [
    payload?.data?.pool,
    Array.isArray(payload?.data?.pools) ? payload.data.pools[0] : null,
    payload?.data?.data?.pool,
    Array.isArray(payload?.data?.data?.pools) ? payload.data.data.pools[0] : null,
    payload?.pool,
    Array.isArray(payload?.pools) ? payload.pools[0] : null,
    payload?.result?.pool,
    Array.isArray(payload?.result?.pools) ? payload.result.pools[0] : null,
    payload?.result,
    payload?.data,
    payload,
  ];
  return candidates.find((entry) => isRecord(entry) && (
    entry.feeTier != null
    || entry.fee_tier != null
    || entry.fee != null
    || entry.tickSpacing != null
    || entry.tick_spacing != null
    || (isRecord(entry.pool) && (entry.pool.feeTier != null || entry.pool.fee != null))
    || entry.token0 != null
    || entry.token1 != null
  )) || null;
}

/** Normalize an indexer Pool entity into the internal pool metadata shape. */
function normalizeIndexerPool(payload, indexer) {
  const entity = pickIndexerEntity(payload);
  if (!entity) return null;

  const nested = isRecord(entity.pool) ? entity.pool : {};
  const rawFee = entity.feeTier
    ?? entity.fee_tier
    ?? nested.feeTier
    ?? nested.fee_tier
    ?? entity.fee
    ?? nested.fee
    ?? null;
  const feePercent = resolveFeePercent(rawFee);
  const rawFeeNumber = Number(rawFee);
  const feeTier = Number.isInteger(rawFeeNumber) && rawFeeNumber > 0 && rawFeeNumber <= 1_000_000
    ? rawFeeNumber
    : null;
  const tickSpacing = num(
    entity.tickSpacing ?? entity.tick_spacing ?? nested.tickSpacing ?? null,
  );

  const tokenA = normalizeIndexerToken(
    entity.token0 ?? entity.token0Address ?? null,
    entity.token0Symbol ?? entity.baseTokenSymbol ?? null,
  );
  const tokenB = normalizeIndexerToken(
    entity.token1 ?? entity.token1Address ?? null,
    entity.token1Symbol ?? entity.quoteTokenSymbol ?? null,
  );
  const [token0, token1] = tokenA.address && tokenB.address
    ? sortTokenAddresses(tokenA.address, tokenB.address)
    : [tokenA.address, tokenB.address];
  const base = sameAddress(tokenA.address, token0) ? tokenA
    : sameAddress(tokenB.address, token0) ? tokenB : null;
  const quote = sameAddress(tokenA.address, token1) ? tokenA
    : sameAddress(tokenB.address, token1) ? tokenB : null;
  const poolAddress = normalizeEvmAddress(entity.id)
    || normalizeEvmAddress(entity.address)
    || normalizeEvmAddress(entity.poolAddress)
    || normalizeEvmAddress(nested.id)
    || null;
  const dexId = String(
    (isRecord(entity.dex) ? entity.dex.id : entity.dexId) || nested.dexId || "",
  );

  return {
    source: indexer.source,
    chain: indexer.chainKey,
    pool: poolAddress,
    feePercent,
    feeTier,
    tickSpacing,
    feeRaw: rawFee,
    token0,
    token1,
    base: base ? { address: base.address, symbol: base.symbol, name: base.name } : null,
    quote: quote ? { address: quote.address, symbol: quote.symbol, name: quote.name } : null,
    pair: base?.symbol && quote?.symbol ? `${base.symbol}/${quote.symbol}` : null,
    dexId,
    dex: dexId ? dexName(dexId) : "Uniswap v3",
  };
}

/** Remaining time before the shared indexer deadline expires. */
function remainingBudget(deadline) {
  return Math.max(250, deadline - Date.now());
}

async function queryIndexerGraphql(indexer, address, fetchImpl, deadline) {
  for (const query of [INDEXER_GRAPHQL_QUERY, INDEXER_GRAPHQL_MIN_QUERY]) {
    if (deadline - Date.now() <= 0) break;
    const payload = await indexerRequest(indexer.url, {
      method: "POST",
      headers: indexerHeaders(indexer, { json: true }),
      body: JSON.stringify({ query, variables: { id: address.toLowerCase() } }),
    }, fetchImpl, remainingBudget(deadline));
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) continue;
    const pool = normalizeIndexerPool(payload, indexer);
    if (pool) return pool;
  }
  return null;
}

async function queryIndexerRest(indexer, address, fetchImpl, deadline) {
  const base = indexer.url.replace(/\/+$/, "");
  const endpoints = base.endsWith("/pools")
    ? [`${base}/${address}`]
    : [`${base}/pools/${address}`, `${base}/pool/${address}`];

  for (const endpoint of endpoints) {
    if (deadline - Date.now() <= 0) break;
    const payload = await indexerRequest(endpoint, {
      method: "GET",
      headers: indexerHeaders(indexer),
    }, fetchImpl, remainingBudget(deadline));
    const pool = normalizeIndexerPool(payload, indexer);
    if (pool) return pool;
  }
  return null;
}

/**
 * Query the configured indexer/subgraph for one pool address.
 * Returns `{ source, feeTier, feePercent, tickSpacing, token0, token1, ... }`
 * or `null` when no indexer is configured or the pool is unknown.
 */
export async function fetchIndexerPool(poolAddress, {
  chainKey,
  config = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  const address = normalizeEvmAddress(poolAddress);
  const indexer = chainKey ? indexerForChain(config, chainKey) : null;
  if (!address || !indexer) return null;

  const budget = Math.max(250, Math.min(
    Number(timeoutMs) > 0 ? Number(timeoutMs) : indexer.timeoutMs,
    indexer.timeoutMs,
  ));
  const deadline = Date.now() + budget;

  for (const protocol of indexerProtocolOrder(indexer)) {
    if (deadline - Date.now() <= 0) break;
    try {
      const pool = protocol === "graphql"
        ? await queryIndexerGraphql(indexer, address, fetchImpl, deadline)
        : await queryIndexerRest(indexer, address, fetchImpl, deadline);
      if (pool && (!pool.pool || sameAddress(pool.pool, address))) {
        return { ...pool, pool: pool.pool || address };
      }
    } catch {
      // Try the next protocol (GraphQL <-> REST) before giving up.
    }
  }
  return null;
}

/**
 * Ordered chain candidates for an indexer lookup. Chain-scoped URLs win over a
 * generic INDEXER_API_URL, so custom chains can be queried deterministically.
 */
function indexerChainCandidates(config, preferred = []) {
  const settings = isRecord(config?.indexer) ? config.indexer : {};
  const explicit = String(settings.chain ?? "").trim().toLowerCase();
  const explicitChain = explicit
    ? Object.values(POOL_CHAINS).find(
      (chain) => chain.key === explicit || String(chain.chainId) === explicit,
    )
    : null;
  const ordered = [
    ...preferred,
    explicitChain?.key,
    String(config?.chain || "").trim().toLowerCase() || null,
    ...Object.keys(settings.byChain || {}),
  ].filter((key) => key && POOL_CHAINS[key]);

  // A generic endpoint has no chain in its URL, so probe every supported chain.
  if (settings.url || process.env?.INDEXER_API_URL) {
    ordered.push(...Object.keys(POOL_CHAINS));
  }
  return [...new Set(ordered)];
}

/** Apply indexer metadata to an existing pool without overwriting API values. */
function applyIndexerMetadata(pool, indexed) {
  if (!pool || !indexed) return false;
  let applied = false;
  if (pool.feePercent == null && indexed.feePercent != null) {
    pool.feePercent = indexed.feePercent;
    pool.feeSource = indexed.source;
    applied = true;
  }
  if (pool.feeTier == null && indexed.feeTier != null) {
    pool.feeTier = indexed.feeTier;
    if (!pool.feeSource) pool.feeSource = indexed.source;
    applied = true;
  }
  if (pool.tickSpacing == null && indexed.tickSpacing != null) {
    pool.tickSpacing = indexed.tickSpacing;
    if (!pool.feeSource) pool.feeSource = indexed.source;
    applied = true;
  }
  return applied;
}

/** Build a displayable pool from indexer-only metadata (no aggregator hit). */
function poolFromIndexer(indexed) {
  if (!indexed?.chain || !POOL_CHAINS[indexed.chain]) return null;
  const tokens = [indexed.token0, indexed.token1].filter(
    (address) => normalizeEvmAddress(address),
  );
  if (tokens.length < 2 || !normalizeEvmAddress(indexed.pool)) return null;

  const pool = syntheticPool({
    address: indexed.pool,
    chainKey: indexed.chain,
    tokens: tokens.slice(0, 2),
    feePercent: indexed.feePercent,
    feeTier: indexed.feeTier,
    tickSpacing: indexed.tickSpacing,
    feeSource: indexed.source,
  });

  const metaFor = (address) => [indexed.base, indexed.quote].find(
    (token) => token && sameAddress(token.address, address),
  );
  const baseMeta = metaFor(pool.base?.address);
  const quoteMeta = metaFor(pool.quote?.address);
  if (baseMeta) pool.base = { ...pool.base, ...baseMeta, address: pool.base.address };
  if (quoteMeta) pool.quote = { ...pool.quote, ...quoteMeta, address: pool.quote.address };

  pool.source = indexed.source;
  pool.feeTier = indexed.feeTier ?? pool.feeTier;
  pool.tickSpacing = indexed.tickSpacing ?? pool.tickSpacing;
  pool.feeRaw = indexed.feeRaw ?? indexed.feeTier ?? pool.feeRaw;
  pool.dex = indexed.dex || "Uniswap v3";
  pool.dexId = indexed.dexId || "uniswap-v3";
  pool.pair = indexed.pair || pool.pair;
  pool.labels = ["v3"];
  return pool;
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
  if (!chainKey) return null;

  const pool = normalizeEvmAddress(pair.pairAddress)
    || normalizeEvmAddress(pair.pairId)
    || normalizeEvmAddress(pair.poolAddress)
    || normalizeEvmAddress(pair.address);
  if (!pool) return null;

  const baseAddress = normalizeEvmAddress(pair.baseToken?.address);
  const quoteAddress = normalizeEvmAddress(pair.quoteToken?.address);
  const [token0, token1] = sortTokenAddresses(baseAddress, quoteAddress);
  const buys = num(pair.txns?.h24?.buys) || 0;
  const sells = num(pair.txns?.h24?.sells) || 0;
  const rawFee = pair.feeTier ?? pair.fee;
  const feePercent = resolveFeePercent(rawFee, pair.feeTier, pair.fee, pair.name);
  const rawFeeNumber = Number(rawFee);
  const chain = POOL_CHAINS[chainKey];

  return {
    source: "dexscreener",
    chain: chainKey,
    dex: dexName(pair.dexId),
    dexId: String(pair.dexId || ""),
    pair: `${pair.baseToken?.symbol || "?"}/${pair.quoteToken?.symbol || "?"}`,
    pool,
    poolId: String(pair.pairAddress || ""),
    feePercent,
    feeTier: Number.isInteger(rawFeeNumber) && rawFeeNumber > 0 ? rawFeeNumber : null,
    feeSource: feePercent != null ? "dexscreener" : null,
    feeRaw: rawFee,
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
    token0,
    token1,
    base: {
      address: baseAddress,
      symbol: pair.baseToken?.symbol || null,
      name: pair.baseToken?.name || null,
    },
    quote: {
      address: quoteAddress,
      symbol: pair.quoteToken?.symbol || null,
      name: pair.quoteToken?.name || null,
    },
    labels: Array.isArray(pair.labels) ? pair.labels : [],
    chartUrl: pair.url || `https://dexscreener.com/${chain.dexScreener}/${pool}`,
  };
}

function pairMatches(pair, address) {
  const target = normalizeEvmAddress(address);
  if (!target) return false;
  return [
    pair.pairAddress,
    pair.pairId,
    pair.poolAddress,
    pair.address,
    pair.baseToken?.address,
    pair.quoteToken?.address,
  ].some((value) => sameAddress(value, target));
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

  return dedupePools(pairs.map(normalizeDexPair).filter(Boolean));
}

function dedupePools(pools) {
  const seen = new Set();
  return pools
    .filter((pool) => {
      const key = `${pool.chain}:${String(pool.pool).toLowerCase()}`;
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
  const pool = normalizeEvmAddress(attrs.address)
    || normalizeEvmAddress(geckoIdPart(item.id));
  if (!pool) return null;

  const baseAddress = normalizeEvmAddress(geckoIdPart(item.relationships?.base_token?.data?.id));
  const quoteAddress = normalizeEvmAddress(geckoIdPart(item.relationships?.quote_token?.data?.id));
  const [token0, token1] = sortTokenAddresses(baseAddress, quoteAddress);
  const rawFee = attrs.fee_tier ?? attrs.fee ?? null;
  const feePercent = resolveFeePercent(
    attrs.fee_tier,
    attrs.fee,
    attrs.pool_fee_percentage,
    attrs.name,
  );
  const rawFeeNumber = Number(rawFee);

  return {
    source: "geckoterminal",
    chain: chainKey,
    dex: dexName(item.relationships?.dex?.data?.id),
    dexId: String(item.relationships?.dex?.data?.id || ""),
    pair: `${baseSymbol || "?"}/${quoteSymbol || "?"}`,
    pool,
    poolId: String(attrs.address || geckoIdPart(item.id) || ""),
    feePercent,
    feeTier: Number.isInteger(rawFeeNumber) && rawFeeNumber > 0 ? rawFeeNumber : null,
    feeSource: feePercent != null ? "geckoterminal" : null,
    feeRaw: rawFee,
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
    token0,
    token1,
    base: {
      address: baseAddress,
      symbol: baseSymbol,
      name: null,
    },
    quote: {
      address: quoteAddress,
      symbol: quoteSymbol,
      name: null,
    },
    labels: [],
    chartUrl: `https://www.geckoterminal.com/${POOL_CHAINS[chainKey].gecko}/pools/${pool}`,
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
      const target = normalizeEvmAddress(address);
      const base = normalizeEvmAddress(geckoIdPart(item.relationships?.base_token?.data?.id));
      const quote = normalizeEvmAddress(geckoIdPart(item.relationships?.quote_token?.data?.id));
      const poolAddress = normalizeEvmAddress(item.attributes?.address);
      if (!sameAddress(target, poolAddress)
        && !sameAddress(target, base)
        && !sameAddress(target, quote)) continue;
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
        return pool && sameAddress(pool.pool, address) ? pool : null;
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) pools.push(result.value);
    }
  }

  return dedupePools(pools);
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
  if (!entry || typeof entry !== "object") return null;

  // GoPlus answers with an error object for unsupported chains/tokens. Treat any
  // response without real safety fields as missing metadata (never as "safe").
  const hasSafetyData = [
    "is_honeypot",
    "is_mintable",
    "is_proxy",
    "is_open_source",
    "buy_tax",
    "sell_tax",
    "holder_count",
    "holders",
  ].some((key) => entry[key] != null);
  if (!hasSafetyData) return null;

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
      const client = router.get?.(pool.chain);
      if (client?.getPoolState) {
        const state = await withTimeout(
          client.getPoolState(pool.pool),
          timeoutMs,
          "pool fee",
        );
        const metadata = feeMetadataFromRaw(state?.fee);
        if (metadata) {
          metadata.tickSpacing = num(state?.tickSpacing) ?? metadata.tickSpacing;
        }
        return metadata;
      }
      if (!client?.provider?.call) return null;
      const data = await withTimeout(
        client.provider.call({ to: pool.pool, data: FEE_SELECTOR }),
        timeoutMs,
        "pool fee",
      );
      return data && data !== "0x" ? feeMetadataFromRaw(BigInt(data)) : null;
    }
    if (!chain?.rpcUrl) return null;
    const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    try {
      const data = await withTimeout(
        provider.call({ to: pool.pool, data: FEE_SELECTOR }),
        5_000,
        "pool fee",
      );
      return data && data !== "0x" ? feeMetadataFromRaw(BigInt(data)) : null;
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

async function callContract(address, data, chain, { config, router, timeoutMs }) {
  try {
    if (config?.rpcByChain?.[chain.key] && router) {
      const client = router.get?.(chain.key);
      if (!client?.provider?.call) return null;
      return await withTimeout(
        client.provider.call({ to: address, data }),
        timeoutMs,
        "contract call",
      );
    }
    if (!chain.rpcUrl) return null;
    const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    try {
      return await withTimeout(provider.call({ to: address, data }), timeoutMs, "contract call");
    } finally {
      provider.destroy();
    }
  } catch {
    return null;
  }
}

/**
 * Determine whether an address is a TOKEN or a POOL contract.
 * A pool implements token0() and token1(); a token implements decimals().
 * Chains are probed concurrently and API-discovered chains are tried first.
 */
async function probeAddressRole(address, {
  chainKeys = [],
  config,
  router,
  enableRpcFallback,
  timeoutMs,
}) {
  if (!enableRpcFallback) return null;
  const keys = [...new Set(chainKeys.filter((key) => POOL_CHAINS[key]))];
  const chains = (keys.length ? keys : Object.keys(POOL_CHAINS))
    .map((key) => POOL_CHAINS[key]);
  if (chains.length === 0) return null;

  const results = await Promise.allSettled(chains.map(async (chain) => {
    const opts = { config, router, timeoutMs };
    const [token0Data, token1Data, decimalsData] = await Promise.all([
      callContract(address, TOKEN0_SELECTOR, chain, opts),
      callContract(address, TOKEN1_SELECTOR, chain, opts),
      callContract(address, DECIMALS_SELECTOR, chain, opts),
    ]);

    const token0 = decodeAddressWord(token0Data);
    const token1 = decodeAddressWord(token1Data);
    if (token0 && token1) {
      let feePercent = null;
      const feeData = await callContract(address, FEE_SELECTOR, chain, opts);
      const rawFee = decodeUint(feeData);
      if (rawFee != null && rawFee <= 1_000_000n) feePercent = feeFromRaw(Number(rawFee));
      return {
        kind: "pool",
        chain: chain.key,
        chainName: chain.name,
        token0,
        token1,
        feePercent,
      };
    }

    const decimals = decodeUint(decimalsData);
    if (decimals != null && decimals <= 36n) return { kind: "token", chain: chain.key };
    return null;
  }));

  const found = results
    .filter((result) => result.status === "fulfilled" && result.value)
    .map((result) => result.value);
  return found.find((role) => role.kind === "pool")
    || found.find((role) => role.kind === "token")
    || null;
}

function poolTokenAddresses(pool) {
  return [...new Set([
    pool?.token0,
    pool?.token1,
    pool?.base?.address,
    pool?.quote?.address,
  ].map((value) => normalizeEvmAddress(value)).filter(Boolean))];
}

function poolsForToken(pools, tokenAddress) {
  return pools.filter((pool) => poolTokenAddresses(pool)
    .some((address) => sameAddress(address, tokenAddress)));
}

function poolsForPool(pools, poolAddress) {
  return pools.filter((pool) => sameAddress(pool.pool, poolAddress));
}

function detectApiAddressRole(address, pools) {
  if (pools.some((pool) => sameAddress(pool.pool, address))) return "pool";
  if (pools.some((pool) => poolTokenAddresses(pool)
    .some((token) => sameAddress(token, address)))) return "token";
  return null;
}

function tokenMetaFromPool(pool, address) {
  const target = normalizeEvmAddress(address);
  if (!target) return null;
  if (sameAddress(pool?.base?.address, target)) return { ...pool.base, address: target };
  if (sameAddress(pool?.quote?.address, target)) return { ...pool.quote, address: target };
  return { address: target, symbol: null, name: null };
}

const STABLE_SYMBOLS = new Set([
  "USDC", "USDC.E", "USDT", "DAI", "BUSD", "FDUSD", "TUSD", "USDD", "USDG",
]);

function isStableMeta(token) {
  return STABLE_SYMBOLS.has(String(token?.symbol || "").toUpperCase());
}

/** Pick the token whose security should drive the risk narrative. */
function pickRiskToken(poolTokens, pool) {
  const metas = poolTokens.map((address) => tokenMetaFromPool(pool, address)).filter(Boolean);
  return metas.find((token) => !isStableMeta(token)) || metas[0] || null;
}

function priceForToken(pool, token) {
  if (!pool || !token) return pool?.priceUsd ?? null;
  const address = String(token.address || "").toLowerCase();
  if (String(pool.base?.address || "").toLowerCase() === address) return pool.priceUsd;
  if (String(pool.quote?.address || "").toLowerCase() === address) return pool.quotePriceUsd;
  return pool.priceUsd;
}

function pickTargetToken(input, pool) {
  if (!pool) return null;
  const target = normalizeEvmAddress(input);
  if (target) {
    if (sameAddress(pool.base?.address, target)) return pool.base;
    if (sameAddress(pool.quote?.address, target)) return pool.quote;
  }

  const baseStable = STABLE_SYMBOLS.has(String(pool.base?.symbol || "").toUpperCase());
  const quoteStable = STABLE_SYMBOLS.has(String(pool.quote?.symbol || "").toUpperCase());
  if (baseStable && !quoteStable) return pool.quote;
  return pool.base;
}

/**
 * Derive the real pool contract for bytes32 pool ids (Uniswap v4-style) using
 * the v3 factory when tokens and a fee tier are known.
 */
async function resolveBytes32PoolAddress(pool, {
  config,
  router,
  enableRpcFallback,
  timeoutMs,
}) {
  const rawId = String(pool.poolId || "");
  if (!enableRpcFallback || !/^0x[0-9a-fA-F]{64}$/.test(rawId)) return pool.pool;
  if (/^0x0{24}/.test(rawId)) return pool.pool;
  if (!pool.feeRaw || !pool.base?.address || !pool.quote?.address) return pool.pool;
  if (!config?.rpcByChain?.[pool.chain] || !router) return pool.pool;
  try {
    const client = router.get?.(pool.chain);
    if (!client?.getPoolAddress) return pool.pool;
    const address = await withTimeout(
      client.getPoolAddress({
        tokenA: pool.base.address,
        tokenB: pool.quote.address,
        fee: Number(pool.feeRaw),
      }),
      timeoutMs,
      "pool address",
    );
    return normalizeEvmAddress(address) || pool.pool;
  } catch {
    return pool.pool;
  }
}

/** Minimal pool record when only on-chain or indexer identity is available. */
function syntheticPool({
  address,
  chainKey,
  tokens,
  feePercent,
  feeTier = null,
  tickSpacing = null,
  feeSource = null,
}) {
  const chain = POOL_CHAINS[chainKey];
  const metas = tokens.map((token) => ({
    address: token,
    symbol: shortAddress(token),
    name: null,
  }));
  const [token0, token1] = sortTokenAddresses(metas[0]?.address, metas[1]?.address);
  return {
    source: "rpc",
    chain: chainKey,
    dex: `${chain.name} pool`,
    dexId: "",
    pair: `${metas[0]?.symbol || "?"}/${metas[1]?.symbol || "?"}`,
    pool: address,
    poolId: address,
    feePercent: feePercent ?? null,
    feeTier: feeTier ?? null,
    tickSpacing: tickSpacing ?? null,
    feeSource: feeSource ?? (feePercent != null ? "rpc" : null),
    feeRaw: feeTier,
    tvl: null,
    volume24h: null,
    priceUsd: null,
    priceNative: null,
    quotePriceUsd: null,
    priceChange24h: null,
    marketCap: null,
    fdv: null,
    buys: 0,
    sells: 0,
    txns24h: 0,
    createdAt: null,
    token0,
    token1,
    base: metas.find((meta) => sameAddress(meta.address, token0)) || metas[0],
    quote: metas.find((meta) => sameAddress(meta.address, token1)) || metas[1],
    labels: [],
    chartUrl: `https://www.geckoterminal.com/${chain.gecko}/pools/${address}`,
  };
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
  if (!flags) {
    safetyNote = "GoPlus has no safety data for this token/chain; treat as unverified "
      + "risk, not as safe.";
  } else {
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

  // Missing GoPlus metadata must never read as "LOW". Keep a HIGH risk derived
  // from liquidity/holder structure, but otherwise surface UNVERIFIED / MEDIUM.
  if (!flags) {
    const warning = "⚠️ Token safety metadata unverified";
    if (!reasons.includes(warning)) reasons.unshift(warning);
    if (riskStatus !== "HIGH") riskStatus = "UNVERIFIED";
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
    riskSeverity: riskStatus === "UNVERIFIED" ? "MEDIUM" : riskStatus,
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

  // Convert bytes32 pair ids/topics returned by DexScreener into real pool
  // contracts (v3 factory) before anything is displayed.
  if (pools.length > 0 && enableRpcFallback) {
    pools = await Promise.all(pools.map(async (pool) => {
      const resolved = await resolveBytes32PoolAddress(pool, {
        config,
        router,
        enableRpcFallback,
        timeoutMs,
      });
      if (resolved && !sameAddress(resolved, pool.pool)) {
        pool.poolId = pool.pool;
        pool.pool = resolved;
      }
      return pool;
    }));
    pools = dedupePools(pools);
  }

  // Secondary indexer fallback: aggregators often omit Uniswap v3 pools on
  // newer EVM chains. Query the Pool entity directly when nothing was found.
  if (pools.length === 0) {
    for (const chainKey of indexerChainCandidates(config, [])) {
      const indexed = await fetchIndexerPool(input, {
        chainKey,
        config,
        fetchImpl,
        timeoutMs,
      });
      if (!indexed?.pool || !sameAddress(indexed.pool, input)) continue;
      const fromIndexer = poolFromIndexer(indexed);
      if (fromIndexer) {
        pools = [fromIndexer];
        break;
      }
    }
  }

  const apiRole = detectApiAddressRole(input, pools);
  const detectedChains = pools.length > 0
    ? []
    : await detectChainsByCode(input, {
      config,
      router,
      enableRpcFallback,
      timeoutMs,
    });
  const chainCandidates = pools.length > 0
    ? [...new Set(pools.map((pool) => pool.chain))]
    : detectedChains;
  const onChainRole = await probeAddressRole(input, {
    chainKeys: chainCandidates,
    config,
    router,
    enableRpcFallback,
    timeoutMs,
  });

  if (pools.length === 0 && !onChainRole) {
    if (detectedChains.length === 0) {
      return {
        address: input,
        pools: [],
        errors,
        error: "No supported EVM chain or active DEX pool found for this address. "
          + "Check the contract address and configured networks.",
      };
    }
    const chain = POOL_CHAINS[detectedChains[0]];
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

  const addressType = onChainRole?.kind || apiRole || "token";

  let scopedPools = [];
  let primary = null;
  let chain = null;
  let poolTokens = [];

  if (addressType === "pool") {
    scopedPools = poolsForPool(pools, input).slice(0, MAX_POOLS);
    primary = scopedPools[0] || null;
    const poolChainKey = primary?.chain || onChainRole?.chain || chainCandidates[0];
    chain = POOL_CHAINS[poolChainKey] || null;

    poolTokens = [...new Set([
      onChainRole?.token0,
      onChainRole?.token1,
      ...(primary ? poolTokenAddresses(primary) : []),
    ].filter(Boolean))];

    if (!primary && chain && poolTokens.length >= 2) {
      primary = syntheticPool({
        address: input,
        chainKey: chain.key,
        tokens: poolTokens.slice(0, 2),
        feePercent: onChainRole?.feePercent,
      });
      scopedPools = [primary];
    }
    if (primary) {
      if (onChainRole?.token0 && onChainRole?.token1) {
        [primary.token0, primary.token1] = sortTokenAddresses(
          onChainRole.token0,
          onChainRole.token1,
        );
      }
      if (primary.feePercent == null && onChainRole?.feePercent != null) {
        primary.feePercent = onChainRole.feePercent;
        primary.feeSource = "rpc";
      }
    }
  } else {
    // Token address: resolve every pool where token0 == address OR token1 == address.
    scopedPools = poolsForToken(pools, input);
    if (scopedPools.length === 0) scopedPools = pools;
    scopedPools = scopedPools.slice(0, MAX_POOLS);
    primary = scopedPools[0] || null;
    const tokenChainKey = primary?.chain || onChainRole?.chain || chainCandidates[0];
    chain = POOL_CHAINS[tokenChainKey] || null;
    poolTokens = [input];
  }

  if (!chain) {
    return {
      address: input,
      pools: [],
      errors,
      error: "No supported EVM chain or active DEX pool found for this address. "
        + "Check the contract address and configured networks.",
    };
  }

  // Fee pipeline: aggregator -> subgraph/indexer -> on-chain fee() RPC.
  // Enrich every displayed pool missing a fee tier, percentage or tick spacing.
  await Promise.all(scopedPools.map(async (pool) => {
    if (pool.feePercent != null && pool.feeTier != null && pool.tickSpacing != null) return;
    const indexed = await fetchIndexerPool(pool.pool, {
      chainKey: pool.chain,
      config,
      fetchImpl,
      timeoutMs,
    });
    applyIndexerMetadata(pool, indexed);
  }));

  // Last resort: read fee() on-chain for pools still missing fee metadata.
  await Promise.all(scopedPools.map(async (pool) => {
    if (pool.feePercent != null && pool.feeTier != null) return;
    const rpcFee = await readFeeOnChain(pool, {
      config,
      router,
      enableRpcFallback,
      timeoutMs,
    });
    if (rpcFee) {
      if (pool.feePercent == null && rpcFee.feePercent != null) {
        pool.feePercent = rpcFee.feePercent;
        pool.feeSource = "rpc";
      }
      if (pool.feeTier == null && rpcFee.feeTier != null) {
        pool.feeTier = rpcFee.feeTier;
      }
      if (pool.tickSpacing == null && rpcFee.tickSpacing != null) {
        pool.tickSpacing = rpcFee.tickSpacing;
      }
      if (!pool.feeSource) pool.feeSource = "rpc";
    }
  }));

  // Token-level security: a token input queries GoPlus with the TOKEN address;
  // a pool input queries GoPlus for both underlying token0 and token1.
  const securityTargets = addressType === "pool" ? poolTokens : [input];
  const securities = [];
  for (const address of securityTargets) {
    let security = null;
    try {
      security = await fetchGoPlus(address, chain.key, fetchImpl, timeoutMs);
    } catch (error) {
      errors.push(`GoPlus (${shortAddress(address)}): ${error.message || String(error)}`);
    }
    if (!security) {
      errors.push(`GoPlus: no safety metadata for ${shortAddress(address)} on ${chain.name}`);
    }
    securities.push({ address, security });
  }

  const picked = addressType === "pool"
    ? pickRiskToken(poolTokens, primary)
    : pickTargetToken(input, primary);
  const token = picked
    ? { address: input === picked.address ? input : picked.address, symbol: picked.symbol, name: picked.name }
    : { address: input, symbol: null, name: null };
  if (addressType === "token") token.address = input;

  // Never substitute another token's security data: a missing risk-token record
  // must stay UNVERIFIED instead of inheriting a verified stablecoin's LOW risk.
  const holders = securities
    .find((entry) => sameAddress(entry.address, token.address))?.security
    || null;

  return {
    address: input,
    addressType,
    kind: addressType,
    chain: chain.key,
    chainName: chain.name,
    chainId: chain.chainId,
    token,
    poolTokens,
    tokenSecurities: securities,
    securityVerified: Boolean(holders),
    priceUsd: primary ? priceForToken(primary, token) : null,
    pools: scopedPools,
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
  return feeTierLabel(value) || "n/a";
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

  const displayAddress = normalizeEvmAddress(analysis.address) || analysis.address;
  lines.push(`Address: <code>${escapeHtml(displayAddress)}</code>`);
  if (analysis.addressType) {
    lines.push(`Type: <b>${analysis.addressType === "pool" ? "POOL" : "TOKEN"}</b>`);
  }
  if (analysis.chainName) {
    lines.push(`Chain: <b>${escapeHtml(analysis.chainName)}</b> (${escapeHtml(analysis.chainId)})`);
  }
  const token = analysis.token;
  if (token) {
    lines.push(
      `Token: <b>${escapeHtml(token.symbol || "?")}</b>`
      + `${token.name ? ` — ${escapeHtml(token.name)}` : ""}`,
    );
    const tokenAddress = normalizeEvmAddress(token.address);
    if (tokenAddress) lines.push(`Token contract: <code>${escapeHtml(tokenAddress)}</code>`);
  }
  if (analysis.poolTokens?.length) {
    const poolTokenAddresses = analysis.poolTokens
      .map((address) => normalizeEvmAddress(address))
      .filter(Boolean);
    if (poolTokenAddresses.length) {
      lines.push(`Pool tokens: <code>${poolTokenAddresses.map(escapeHtml).join("</code> / <code>")}</code>`);
    }
  }

  if (analysis.note) {
    lines.push("", `⚠️ ${escapeHtml(analysis.note)}`);
  }

  lines.push("", `<b>Liquidity &amp; Pools</b> (${analysis.pools?.length || 0} found)`);
  if (!analysis.pools?.length) {
    lines.push("No active DEX pools found.");
  }

  const shownPools = (analysis.pools || []).slice(0, DETAILED_POOLS);
  for (const [index, pool] of shownPools.entries()) {
    const poolAddress = normalizeEvmAddress(pool.pool);
    if (!poolAddress) continue;
    const links = [];
    if (pool.chartUrl) {
      links.push(`<a href="${escapeHtmlAttr(pool.chartUrl)}">Chart</a>`);
    }
    const dexUrl = dexPoolUrl(pool);
    if (dexUrl) links.push(`<a href="${escapeHtmlAttr(dexUrl)}">DEX</a>`);
    links.push(`<a href="${escapeHtmlAttr(explorerUrl({ ...pool, pool: poolAddress }))}">Explorer</a>`);

    const tier = feeTierLabel(pool.feePercent);
    lines.push(
      `${index + 1}. <b>${escapeHtml(pool.pair)}</b> — ${escapeHtml(pool.dex)}`
      + `${tier ? ` (${tier})` : ""}`,
    );
    lines.push(
      `   Pool <code>${escapeHtml(poolAddress)}</code> | fee ${fmtFee(pool.feePercent)}`
      + `${pool.tickSpacing != null ? ` | tick ${escapeHtml(pool.tickSpacing)}` : ""}`,
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

  const minorPools = (analysis.pools || []).slice(DETAILED_POOLS);
  if (minorPools.length > 0) {
    const minorTvl = minorPools.reduce((sum, pool) => sum + (num(pool.tvl) ?? 0), 0);
    const labels = minorPools.map((pool) => {
      const poolAddress = normalizeEvmAddress(pool.pool);
      return `${pool.pair}${poolAddress ? ` (${shortAddress(poolAddress)})` : ""} ${fmtMoney(pool.tvl)}`;
    });
    lines.push(
      `…+${minorPools.length} minor pools (${fmtMoney(minorTvl)} TVL): ${labels.join(", ")}`,
    );
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
  if (!holders) lines.push("⚠️ Token safety metadata unverified");
  if (analysis.addressType === "pool" && analysis.tokenSecurities?.length) {
    const checks = analysis.tokenSecurities.map((entry) => {
      const address = normalizeEvmAddress(entry.address);
      return `<code>${escapeHtml(address ? shortAddress(address) : "n/a")}</code> `
        + `${entry.security ? "verified" : "UNVERIFIED"}`;
    });
    lines.push(`Pool token checks: ${checks.join(" | ")}`);
  }
  lines.push(`Activity: ${escapeHtml(narrative.activityNote)}`);

  lines.push("", "<b>Narrative &amp; Market Insight</b>");
  lines.push(`Volume health: ${escapeHtml(narrative.volumeHealth)}`);
  lines.push(`Liquidity depth: ${escapeHtml(narrative.liquidityNote)}`);
  lines.push(`Holder profile: ${escapeHtml(narrative.holderNote)}`);
  const riskLabel = narrative.riskStatus === "UNVERIFIED"
    ? "UNVERIFIED (MEDIUM)"
    : narrative.riskStatus;
  lines.push(
    `Risk: <b>${escapeHtml(riskLabel)}</b> — `
    + `${escapeHtml(narrative.reasons.join("; "))}`,
  );

  if (analysis.errors?.length) {
    lines.push("", `<i>Data warnings: ${analysis.errors.map(escapeHtml).join("; ")}</i>`);
  }
  return lines.join("\n");
}







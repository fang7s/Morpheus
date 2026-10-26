// ─── User-triggered /deploy flow with safety guardrails ───────────────
// The bot never scans or buys passively: a deployment starts only when an
// authorized Telegram user sends `/deploy <token_address>`. This module runs
// the pre-flight checks, drives the inline-menu state machine, and mints the
// Uniswap v3 LP position with the configured WALLET_PRIVATE_KEY.

import { randomBytes } from "crypto";
import { Interface, formatUnits, parseUnits } from "ethers";
import { log } from "../logger.js";
import { configuredWallet } from "./discovery.js";
import { escapeHtml } from "./html.js";
import { normalizeEvmAddress } from "./pool-analysis.js";
import { NPM_ABI, tickToPrice } from "./uniswap-v3.js";
import {
  formatManagementCard,
  managementKeyboard,
  upsertAutomation,
  automationFilePath,
} from "./position-manager.js";

const GOPLUS_API = "https://api.gopluslabs.io/api/v1";
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";
const SESSION_TTL_MS = 15 * 60_000;
const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
const LOG_1_0001 = Math.log(1.0001);
const BPS = 10_000n;
const MINT_INTERFACE = new Interface(NPM_ABI);
const PRICE_CACHE_MS = 60_000;
const priceCache = new Map();

const GOPLUS_CHAIN_IDS = {
  1: 1,
  10: 10,
  56: 56,
  137: 137,
  8453: 8453,
  42161: 42161,
  43114: 43114,
};
const STABLE_SYMBOLS = new Set(["USDC", "USDC.E", "USDT", "DAI", "FDUSD", "BUSD"]);
const QUOTE_PRIORITY = ["WETH", "USDC", "USDT", "DAI", "WBTC", "cbBTC", "WBNB", "BNB"];
const FEE_TIERS = [100, 500, 3_000, 10_000];

export const DEPLOY_SIDES = {
  base: { key: "base", label: "Single-Side Base" },
  quote: { key: "quote", label: "Single-Side Quote" },
  dual: { key: "dual", label: "Dual 50:50" },
};

export const DEPLOY_RANGES = {
  narrow: { key: "narrow", label: "Narrow ±2%", pct: 2 },
  moderate: { key: "moderate", label: "Moderate ±5%", pct: 5 },
  wide: { key: "wide", label: "Wide ±15%", pct: 15 },
};

const sessions = new Map();

export function clearDeploySessions() {
  sessions.clear();
}

export function getDeploySession(id) {
  const session = sessions.get(String(id));
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(String(id));
    return null;
  }
  return session;
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(id);
  }
}

function newId() {
  return randomBytes(5).toString("hex");
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatUsd(value) {
  const number = finite(value);
  return number == null ? "n/a" : `$${number.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatAmount(value, decimals = 6) {
  const number = finite(value);
  if (number == null) return "0";
  const digits = Math.max(0, Math.min(8, Number(decimals) || 6));
  return number.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function formatPrice(value) {
  const number = finite(value);
  if (number == null || number <= 0) return "n/a";
  if (number >= 1_000) return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (number >= 1) return number.toPrecision(6);
  return number.toPrecision(5);
}

function shortAddress(value) {
  const address = String(value || "");
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

async function fetchJson(url, fetchImpl = globalThis.fetch, timeoutMs = 8_000) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tick / range math ───────────────────────────────────────────────

export function tickDeltaForPct(rangePct) {
  const pct = Number(rangePct);
  if (!Number.isFinite(pct) || pct <= 0) return 1;
  return Math.max(1, Math.round(Math.log1p(pct / 100) / LOG_1_0001));
}

export function floorToSpacing(tick, tickSpacing) {
  const spacing = Math.max(1, Math.floor(Number(tickSpacing) || 1));
  const value = Math.floor(Number(tick) / spacing) * spacing;
  return value === 0 ? 0 : value;
}

export function ceilToSpacing(tick, tickSpacing) {
  const spacing = Math.max(1, Math.floor(Number(tickSpacing) || 1));
  const value = Math.ceil(Number(tick) / spacing) * spacing;
  return value === 0 ? 0 : value;
}

/**
 * Convert a current tick + range percentage into usable tick bounds.
 * Single-side deployments are anchored entirely on the side of the book that
 * only needs the selected token (token0 above spot, token1 below spot), so the
 * deposit truly is one-sided.
 */
export function computeTickRange({
  tick,
  tickSpacing,
  rangePct,
  side = "dual",
  baseIsToken0 = true,
}) {
  const spacing = Math.max(1, Math.floor(Number(tickSpacing) || 1));
  const current = Math.trunc(Number(tick) || 0);
  const delta = Math.max(spacing, tickDeltaForPct(rangePct));
  let tickLower;
  let tickUpper;

  if (!side || side === "dual") {
    tickLower = floorToSpacing(current - delta, spacing);
    tickUpper = ceilToSpacing(current + delta, spacing);
  } else {
    const wantsToken0 = (side === "base") === Boolean(baseIsToken0);
    if (wantsToken0) {
      // Range above spot: liquidity is 100% token0.
      tickLower = ceilToSpacing(current + 1, spacing);
      tickUpper = ceilToSpacing(current + delta, spacing);
    } else {
      // Range below spot: liquidity is 100% token1.
      tickLower = floorToSpacing(current - delta, spacing);
      tickUpper = floorToSpacing(current - 1, spacing);
    }
  }

  tickLower = Math.max(MIN_TICK, tickLower);
  tickUpper = Math.min(MAX_TICK, tickUpper);
  if (tickLower >= tickUpper) {
    if (tickUpper + spacing <= MAX_TICK) tickUpper = tickLower + spacing;
    else tickLower = tickUpper - spacing;
  }
  return { tickLower, tickUpper, tickSpacing: spacing, tickDelta: delta };
}

/** Human price bounds oriented as quote-per-base. */
export function rangePriceBounds({
  tickLower,
  tickUpper,
  decimals0,
  decimals1,
  baseIsToken0 = true,
}) {
  const poolLower = tickToPrice(tickLower, decimals0, decimals1);
  const poolUpper = tickToPrice(tickUpper, decimals0, decimals1);
  if (baseIsToken0) {
    return { priceLower: poolLower, priceUpper: poolUpper };
  }
  return {
    priceLower: poolUpper > 0 ? 1 / poolUpper : null,
    priceUpper: poolLower > 0 ? 1 / poolLower : null,
  };
}

// ─── Pre-execution guardrails ────────────────────────────────────────

/** GoPlus returns tax as a 0..1 fraction; normalize to percent. */
export function parseTaxPercent(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number <= 1 ? number * 100 : number;
}

function goPlusBool(value) {
  if (value == null || value === "") return null;
  return String(value) === "1" || value === true;
}

export function normalizeTokenSecurity(entry) {
  if (!entry || typeof entry !== "object") return null;
  const hasData = [
    "is_honeypot",
    "buy_tax",
    "sell_tax",
    "cannot_sell_all",
    "is_transferable",
    "is_open_source",
    "holder_count",
  ].some((key) => entry[key] != null);
  if (!hasData) return null;
  return {
    honeypot: goPlusBool(entry.is_honeypot),
    buyTax: parseTaxPercent(entry.buy_tax),
    sellTax: parseTaxPercent(entry.sell_tax),
    transferable: goPlusBool(entry.is_transferable),
    cannotSellAll: goPlusBool(entry.cannot_sell_all),
    transferPausable: goPlusBool(entry.transfer_pausable),
    blacklisted: goPlusBool(entry.is_blacklisted),
    mintable: goPlusBool(entry.is_mintable),
    openSource: goPlusBool(entry.is_open_source),
    holderCount: finite(entry.holder_count),
  };
}


/**
 * Evaluate token transferability + buy/sell tax.
 * Missing security data fails closed unless `allowUnverified` is enabled.
 */
export function evaluateSecurity(security, { maxTaxPct = 1, allowUnverified = false } = {}) {
  const checks = [];
  const reasons = [];
  const warnings = [];

  if (!security) {
    if (allowUnverified) {
      return {
        ok: true,
        checks,
        reasons,
        warnings: [
          "Token security could not be verified; continuing because DEPLOY_ALLOW_UNVERIFIED=true.",
        ],
      };
    }
    return {
      ok: false,
      checks,
      reasons: ["Token security could not be verified (no GoPlus safety data)."],
      warnings,
    };
  }

  if (security.honeypot === true) reasons.push("Honeypot detected by GoPlus.");
  if (security.cannotSellAll === true) reasons.push("Token cannot be sold in full (cannot_sell_all).");
  if (security.transferable === false) reasons.push("Token transfers are currently disabled.");
  if (security.blacklisted === true) warnings.push("Token is blacklisted.");

  const limit = Number(maxTaxPct);
  if (security.buyTax != null) {
    if (security.buyTax > limit) {
      reasons.push(`Buy tax ${security.buyTax.toFixed(2)}% exceeds ${limit}%.`);
    } else {
      checks.push(`buy tax ${security.buyTax.toFixed(2)}%`);
    }
  } else {
    warnings.push("Buy tax is not reported.");
  }
  if (security.sellTax != null) {
    if (security.sellTax > limit) {
      reasons.push(`Sell tax ${security.sellTax.toFixed(2)}% exceeds ${limit}%.`);
    } else {
      checks.push(`sell tax ${security.sellTax.toFixed(2)}%`);
    }
  } else {
    warnings.push("Sell tax is not reported.");
  }
  if (security.transferPausable === true) warnings.push("Owner can pause transfers.");
  if (security.openSource === false) warnings.push("Contract source is not verified.");

  return { ok: reasons.length === 0, checks, reasons, warnings };
}

export function gasCost({ gasPriceWei, gasLimit, nativeUsdPrice }) {
  const price = BigInt(gasPriceWei ?? 0);
  const limit = BigInt(Math.max(0, Math.trunc(Number(gasLimit) || 0)));
  const costWei = price * limit;
  const native = Number(costWei) / 1e18;
  const usd = native * (Number(nativeUsdPrice) || 0);
  return { costWei, native, usd };
}

/** Abort when the estimated transaction fee exceeds MAX_GAS_FEE_USD. */
export function evaluateGas({
  gasPriceWei,
  gasLimit,
  nativeUsdPrice,
  maxGasFeeUsd = 0.5,
}) {
  if (gasPriceWei == null) {
    return { ok: false, reason: "Gas price is unavailable from the RPC.", cost: null };
  }
  if (!(Number(nativeUsdPrice) > 0)) {
    return { ok: false, reason: "Native token USD price is unavailable.", cost: null };
  }
  const cost = gasCost({ gasPriceWei, gasLimit, nativeUsdPrice });
  const max = Number(maxGasFeeUsd);
  if (!Number.isFinite(max) || max <= 0) {
    return { ok: true, cost, warning: "MAX_GAS_FEE_USD is disabled." };
  }
  const ok = cost.usd <= max;
  return {
    ok,
    cost,
    reason: ok ? null : `Estimated gas ${formatUsd(cost.usd)} exceeds MAX_GAS_FEE_USD ${formatUsd(max)}.`,
    warning: ok && cost.usd >= max * 0.8
      ? `Gas is close to the limit (${formatUsd(cost.usd)} of ${formatUsd(max)}).`
      : null,
  };
}

/** Compare wallet ERC20 balances/allowances with the desired mint amounts. */
export function evaluateAllowances({ requirements = [], balances = {}, allowances = {} } = {}) {
  const missing = [];
  const insufficient = [];
  for (const requirement of requirements) {
    const key = String(requirement.token || "").toLowerCase();
    const amount = BigInt(requirement.amount ?? 0);
    if (amount <= 0n) continue;
    const balance = BigInt(balances[key] ?? 0);
    const allowance = BigInt(allowances[key] ?? 0);
    if (balance < amount) {
      insufficient.push({
        token: requirement.token,
        symbol: requirement.symbol || null,
        required: amount,
        available: balance,
      });
    }
    if (allowance < amount) {
      missing.push({
        token: requirement.token,
        symbol: requirement.symbol || null,
        amount,
        allowance,
      });
    }
  }
  return { ok: insufficient.length === 0, missing, insufficient };
}


/** Split a USD budget across the selected side, capped by wallet balances. */
export function allocateDeployAmounts({
  side = "dual",
  budgetUsd = 100,
  baseUsdPrice,
  quoteUsdPrice,
  baseBalance = 0,
  quoteBalance = 0,
} = {}) {
  const budget = Math.max(0, Number(budgetUsd) || 0);
  const basePrice = Number(baseUsdPrice);
  const quotePrice = Number(quoteUsdPrice);
  const baseAvailable = Math.max(0, Number(baseBalance) || 0);
  const quoteAvailable = Math.max(0, Number(quoteBalance) || 0);

  const baseBudgetUsd = side === "base" ? budget : side === "quote" ? 0 : budget / 2;
  const quoteBudgetUsd = side === "quote" ? budget : side === "base" ? 0 : budget / 2;
  const wantBase = basePrice > 0 ? baseBudgetUsd / basePrice : 0;
  const wantQuote = quotePrice > 0 ? quoteBudgetUsd / quotePrice : 0;
  const baseAmount = Math.min(wantBase, baseAvailable);
  const quoteAmount = Math.min(wantQuote, quoteAvailable);
  const baseUsd = baseAmount * (basePrice > 0 ? basePrice : 0);
  const quoteUsd = quoteAmount * (quotePrice > 0 ? quotePrice : 0);

  return {
    baseAmount,
    quoteAmount,
    baseUsd,
    quoteUsd,
    totalUsd: baseUsd + quoteUsd,
    capped: wantBase > baseAvailable + 1e-12 || wantQuote > quoteAvailable + 1e-12,
  };
}

// ─── Transaction encoding ────────────────────────────────────────────

export function buildMintParams({
  token0,
  token1,
  fee,
  tickLower,
  tickUpper,
  amount0Desired,
  amount1Desired,
  recipient,
  deadline,
  slippageBps = 100,
}) {
  const amount0 = BigInt(amount0Desired ?? 0);
  const amount1 = BigInt(amount1Desired ?? 0);
  const slippage = BigInt(Math.min(9_999, Math.max(0, Math.floor(Number(slippageBps) || 0))));
  const keep = BPS - slippage;
  return {
    token0,
    token1,
    fee: Number(fee),
    tickLower: Number(tickLower),
    tickUpper: Number(tickUpper),
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min: (amount0 * keep) / BPS,
    amount1Min: (amount1 * keep) / BPS,
    recipient,
    deadline: Number(deadline),
  };
}

/** ABI-encode the NPM mint() tuple (exported for tests and gas estimation). */
export function encodeMintCalldata(params) {
  return MINT_INTERFACE.encodeFunctionData("mint", [params]);
}


// ─── Network resolution helpers ──────────────────────────────────────

export async function fetchTokenSecurity({
  token,
  chainId,
  chainKey = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  const goplusChainId = GOPLUS_CHAIN_IDS[Number(chainId)];
  if (!goplusChainId || !token) {
    log("panda_warn", `GoPlus security is unavailable for chain ${chainId} (${chainKey || "?"})`);
    return null;
  }
  try {
    const payload = await fetchJson(
      `${GOPLUS_API}/token_security/${goplusChainId}`
      + `?contract_addresses=${encodeURIComponent(token)}`,
      fetchImpl,
      timeoutMs,
    );
    const entry = payload?.result?.[String(token).toLowerCase()]
      || Object.values(payload?.result || {})[0];
    return normalizeTokenSecurity(entry);
  } catch (error) {
    log("panda_warn", `GoPlus security check failed: ${error?.message || String(error)}`);
    return null;
  }
}

function extractUsdPrice(payload, token, chainId, chainSlug = null) {
  const address = String(token).toLowerCase();
  const chainMatches = new Set(
    [chainId, chainSlug].filter((value) => value != null && value !== "").map(
      (value) => String(value).toLowerCase(),
    ),
  );
  for (const pair of payload?.pairs || []) {
    if (chainMatches.size && pair.chainId != null
      && !chainMatches.has(String(pair.chainId).toLowerCase())) {
      continue;
    }
    const priceUsd = Number(pair.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    if (String(pair.baseToken?.address || "").toLowerCase() === address) return priceUsd;
    const priceNative = Number(pair.priceNative);
    if (String(pair.quoteToken?.address || "").toLowerCase() === address
      && Number.isFinite(priceNative) && priceNative > 0) {
      return priceUsd / priceNative;
    }
  }
  return null;
}

/** USD spot price for an ERC20, derived from DexScreener pairs. */
export async function fetchTokenUsdPrice({
  token,
  symbol = null,
  chainId = null,
  chainSlug = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  fallback = 0,
} = {}) {
  const override = Number(fallback);
  if (Number.isFinite(override) && override > 0) return override;
  if (symbol && STABLE_SYMBOLS.has(String(symbol).toUpperCase())) return 1;
  if (!token) return null;

  const key = `${chainId || "any"}:${String(token).toLowerCase()}`;
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.value;

  try {
    const payload = await fetchJson(
      `${DEXSCREENER_API}/tokens/${encodeURIComponent(token)}`,
      fetchImpl,
      timeoutMs,
    );
    const price = extractUsdPrice(payload, token, chainId, chainSlug);
    if (price != null) priceCache.set(key, { at: Date.now(), value: price });
    return price;
  } catch (error) {
    log("panda_warn", `USD price lookup failed for ${shortAddress(token)}: ${error.message}`);
    return null;
  }
}

/** Find the deepest Uniswap v3 pool for `token` against a known quote token. */
export async function resolveDeployPool({ token, client, chainConfig } = {}) {
  if (!client || !chainConfig) throw new Error("resolveDeployPool requires a client and chain config");
  const candidates = [];
  const seenQuotes = new Set();
  const tokens = chainConfig.tokens || {};
  const ordered = [
    ...QUOTE_PRIORITY.filter((symbol) => tokens[symbol]),
    ...Object.keys(tokens).filter((symbol) => !QUOTE_PRIORITY.includes(symbol)),
  ];
  for (const symbol of ordered) {
    const address = tokens[symbol];
    if (!address || String(address).toLowerCase() === String(token).toLowerCase()) continue;
    if (seenQuotes.has(String(address).toLowerCase())) continue;
    seenQuotes.add(String(address).toLowerCase());
    for (const fee of FEE_TIERS) candidates.push({ quoteAddress: address, quoteSymbol: symbol, fee });
  }

  const results = await Promise.allSettled(candidates.map(async (candidate) => {
    const pool = await client.getPoolAddress({
      tokenA: token,
      tokenB: candidate.quoteAddress,
      fee: candidate.fee,
    });
    const state = await client.getPoolState(pool);
    return { ...candidate, pool, state };
  }));

  const pools = [];
  const seenPools = new Set();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const value = result.value;
    const key = String(value.pool).toLowerCase();
    if (seenPools.has(key)) continue;
    seenPools.add(key);
    pools.push(value);
  }
  if (!pools.length) {
    throw new Error("No Uniswap v3 pool found against the chain's known quote tokens.");
  }

  pools.sort((a, b) => {
    const left = BigInt(a.state.liquidity || 0);
    const right = BigInt(b.state.liquidity || 0);
    if (left === right) return 0;
    return left > right ? -1 : 1;
  });
  return pools[0];
}


// ─── Telegram menu rendering ─────────────────────────────────────────

function cancelButton(id) {
  return { text: "Cancel", callback_data: `dp:z:${id}` };
}

function step1Keyboard(session) {
  return {
    inline_keyboard: [
      [
        { text: "Single-Side Base", callback_data: `dp:s:base:${session.id}` },
        { text: "Single-Side Quote", callback_data: `dp:s:quote:${session.id}` },
      ],
      [{ text: "Dual 50:50", callback_data: `dp:s:dual:${session.id}` }],
      [cancelButton(session.id)],
    ],
  };
}

function step2Keyboard(session) {
  return {
    inline_keyboard: [
      [
        { text: "Narrow ±2%", callback_data: `dp:r:narrow:${session.id}` },
        { text: "Moderate ±5%", callback_data: `dp:r:moderate:${session.id}` },
      ],
      [{ text: "Wide ±15%", callback_data: `dp:r:wide:${session.id}` }],
      [
        { text: "Back", callback_data: `dp:b:1:${session.id}` },
        cancelButton(session.id),
      ],
    ],
  };
}

function confirmKeyboard(session) {
  return {
    inline_keyboard: [
      [{ text: "🚀 Confirm & Mint", callback_data: `dp:m:${session.id}` }],
      [
        { text: "Back", callback_data: `dp:b:2:${session.id}` },
        cancelButton(session.id),
      ],
    ],
  };
}

function sideText(session) {
  return DEPLOY_SIDES[session.side]?.label || "n/a";
}

function rangeText(session) {
  return DEPLOY_RANGES[session.rangeKey]?.label
    || `±${Number(session.rangePct).toFixed(0)}%`;
}

function guardrailText(session) {
  const security = session.security;
  const securityBits = [];
  if (security?.honeypot === false) securityBits.push("honeypot: no");
  if (security?.buyTax != null) securityBits.push(`buy tax ${security.buyTax.toFixed(2)}%`);
  if (security?.sellTax != null) securityBits.push(`sell tax ${security.sellTax.toFixed(2)}%`);
  if (security?.transferable === true) securityBits.push("transferable: yes");
  const lines = [
    `<b>🚀 Deploy pre-flight — ${escapeHtml(session.baseSymbol)}/`
    + `${escapeHtml(session.quoteSymbol)}</b>`,
    `Chain: ${escapeHtml(session.chain)} | Budget: ${formatUsd(session.budgetUsd)}`,
    `Token: <code>${escapeHtml(session.baseAddress)}</code>`,
    `Pool: <code>${escapeHtml(shortAddress(session.pool))}</code> | fee ${session.fee}`
    + ` | tick spacing ${session.tickSpacing}`,
    `Spot: ${formatPrice(session.basePriceInQuote)} ${escapeHtml(session.quoteSymbol)}`
    + ` per ${escapeHtml(session.baseSymbol)} (tick ${session.tick})`,
    "",
    `<b>Guardrails</b>`,
    `Security: ${securityBits.length ? escapeHtml(securityBits.join(" | ")) : "unverified"}`,
  ];
  for (const check of session.guardrails?.securityChecks || []) {
    if (!securityBits.length) lines.push(`   ✅ ${escapeHtml(check)}`);
  }
  if (session.guardrails?.gas) {
    const gas = session.guardrails.gas;
    lines.push(
      `Gas: ${gas.cost ? `${gas.cost.native.toFixed(8)} ${escapeHtml(session.nativeSymbol)}`
        + ` ≈ ${formatUsd(gas.cost.usd)}` : "n/a"}`
      + ` (max ${formatUsd(session.maxGasFeeUsd)}) ${gas.ok ? "✅" : "❌"}`,
    );
  }
  lines.push(
    `Wallet: ${formatAmount(session.balances.baseHuman, session.baseDecimals)} `
    + `${escapeHtml(session.baseSymbol)} | `
    + `${formatAmount(session.balances.quoteHuman, session.quoteDecimals)} `
    + `${escapeHtml(session.quoteSymbol)}`,
  );
  for (const warning of session.guardrails?.warnings || []) {
    lines.push(`⚠️ ${escapeHtml(warning)}`);
  }
  lines.push(
    "",
    "<b>Step 1/3 — Choose the deposit side</b>",
    "<i>Single-side positions are anchored on the base-only or quote-only side of the book.</i>",
  );
  return lines.join("\n");
}

function abortText(title, reasons = [], warnings = []) {
  const lines = [`<b>❌ Deployment aborted — ${escapeHtml(title)}</b>`];
  for (const reason of reasons) lines.push(`• ${escapeHtml(reason)}`);
  for (const warning of warnings) lines.push(`⚠️ ${escapeHtml(warning)}`);
  lines.push("", "No approval or transaction was sent.");
  return lines.join("\n");
}

function usageText() {
  return "<b>Deploy an LP position</b>\n"
    + "Usage: <code>/deploy &lt;token_address&gt;</code>\n\n"
    + "The bot never scans or buys passively. This flow starts only when you send the command.\n"
    + "Pre-flight checks: transferability + taxes, gas vs MAX_GAS_FEE_USD, balance and ERC20 allowance.";
}

function nativeSymbolFor(chainConfig) {
  return chainConfig?.nativeSymbol || "ETH";
}


// ─── Deployment start: guardrails then Step 1 ────────────────────────

async function readBalance(client, token, owner) {
  try {
    return BigInt(await client.getTokenContract(token).balanceOf(owner));
  } catch (error) {
    log("panda_warn", `balanceOf failed for ${shortAddress(token)}: ${error.message}`);
    return 0n;
  }
}

async function readAllowance(client, token, owner) {
  try {
    return BigInt(
      await client.getTokenContract(token).allowance(owner, client.config.positionManager),
    );
  } catch (error) {
    log("panda_warn", `allowance failed for ${shortAddress(token)}: ${error.message}`);
    return 0n;
  }
}

async function readGasPrice(client) {
  const feeData = await client.provider.getFeeData();
  return feeData?.maxFeePerGas ?? feeData?.gasPrice ?? null;
}

/**
 * Passive trigger: `/deploy <token_address>`.
 * Runs all pre-flight guardrails and, only when they pass, returns the Step 1
 * inline keyboard. Never called from a scanner or background loop.
 */
export async function startDeployment(ctx, args = [], options = {}) {
  pruneSessions();
  const address = args[0];
  const token = normalizeEvmAddress(address);
  if (!token) {
    return { text: usageText(), replyMarkup: null };
  }

  const config = ctx?.config;
  const chainConfig = config?.chainConfig;
  const router = ctx?.router;
  if (!config || !chainConfig || !router) {
    return {
      text: abortText("Configuration error", ["Chain router/config is unavailable."]),
      replyMarkup: null,
    };
  }

  const owner = configuredWallet(config);
  if (!owner) {
    return {
      text: abortText("Wallet unavailable", [
        "Set WALLET_PRIVATE_KEY (or DISCOVERY_WALLET) so the bot can read balances.",
      ]),
      replyMarkup: null,
    };
  }

  const fetchImpl = options.fetchImpl || ctx.fetchImpl || globalThis.fetch;
  const deploy = config.deploy || {};
  let client;
  let resolved;
  try {
    client = router.get(chainConfig.key);
    resolved = await resolveDeployPool({ token, client, chainConfig });
  } catch (error) {
    return {
      text: abortText("Pool resolution failed", [error?.message || String(error)]),
      replyMarkup: null,
    };
  }

  const { state } = resolved;
  const baseIsToken0 = String(state.token0).toLowerCase() === token.toLowerCase();
  const baseDecimals = baseIsToken0 ? state.decimals0 : state.decimals1;
  const quoteDecimals = baseIsToken0 ? state.decimals1 : state.decimals0;
  const quoteAddress = baseIsToken0 ? state.token1 : state.token0;
  const baseSymbol = (baseIsToken0 ? state.token0Symbol : state.token1Symbol)
    || shortAddress(token);
  const quoteSymbol = (baseIsToken0 ? state.token1Symbol : state.token0Symbol)
    || shortAddress(quoteAddress);
  const basePriceInQuote = baseIsToken0 ? Number(state.price) : 1 / Number(state.price);
  return proceedDeploymentStart(ctx, {
    config,
    chainConfig,
    client,
    owner,
    token,
    resolved,
    state,
    baseIsToken0,
    baseDecimals,
    quoteDecimals,
    quoteAddress,
    baseSymbol,
    quoteSymbol,
    basePriceInQuote,
    fetchImpl,
    deploy,
  });
}

async function proceedDeploymentStart(ctx, params) {
  const {
    config, chainConfig, client, owner, token, resolved, state, baseIsToken0,
    baseDecimals, quoteDecimals, quoteAddress, baseSymbol, quoteSymbol,
    basePriceInQuote, fetchImpl, deploy,
  } = params;


  const [security, baseUsdRaw, quoteUsdRaw, baseRaw, quoteRaw, nativeRaw, gasPriceWei] =
    await Promise.all([
      fetchTokenSecurity({
        token,
        chainId: config.chainId,
        chainKey: chainConfig.key,
        fetchImpl,
        timeoutMs: deploy.securityTimeoutMs,
      }),
      fetchTokenUsdPrice({
        token,
        symbol: baseSymbol,
        chainId: config.chainId,
        chainSlug: chainConfig.dexscreenerChain,
        fetchImpl,
        timeoutMs: deploy.priceTimeoutMs,
      }),
      fetchTokenUsdPrice({
        token: quoteAddress,
        symbol: quoteSymbol,
        chainId: config.chainId,
        chainSlug: chainConfig.dexscreenerChain,
        fetchImpl,
        timeoutMs: deploy.priceTimeoutMs,
      }),
      readBalance(client, token, owner),
      readBalance(client, quoteAddress, owner),
      client.provider.getBalance(owner).catch(() => 0n),
      readGasPrice(client).catch(() => null),
    ]);

  let baseUsdPrice = baseUsdRaw;
  let quoteUsdPrice = quoteUsdRaw;
  if (!(baseUsdPrice > 0) && quoteUsdPrice > 0 && basePriceInQuote > 0) {
    baseUsdPrice = quoteUsdPrice * basePriceInQuote;
  }
  if (!(quoteUsdPrice > 0) && baseUsdPrice > 0 && basePriceInQuote > 0) {
    quoteUsdPrice = baseUsdPrice / basePriceInQuote;
  }

  const wrappedSymbol = chainConfig.wrappedNative || "WETH";
  const wrappedAddress = chainConfig.tokens?.[wrappedSymbol]
    || chainConfig.tokens?.WETH
    || chainConfig.tokens?.WBNB;
  const nativeUsdPrice = await fetchTokenUsdPrice({
    token: wrappedAddress,
    symbol: wrappedSymbol,
    chainId: config.chainId,
    chainSlug: chainConfig.dexscreenerChain,
    fetchImpl,
    timeoutMs: deploy.priceTimeoutMs,
    fallback: deploy.nativeUsdPrice,
  });

  const securityEval = evaluateSecurity(security, {
    maxTaxPct: deploy.maxTaxPct,
    allowUnverified: deploy.allowUnverified,
  });
  const gasUnits = Number(deploy.gasLimitEstimate) + Number(deploy.approveGasLimitEstimate);
  const gasEval = evaluateGas({
    gasPriceWei,
    gasLimit: gasUnits,
    nativeUsdPrice,
    maxGasFeeUsd: deploy.maxGasFeeUsd,
  });

  const reasons = [...securityEval.reasons];
  if (!gasEval.ok) reasons.push(gasEval.reason);
  if (!(baseUsdPrice > 0) && !(quoteUsdPrice > 0)) {
    reasons.push("USD prices are unavailable, so deposit sizing cannot be verified.");
  }
  if (baseRaw <= 0n && quoteRaw <= 0n) {
    reasons.push("Wallet holds neither the base token nor the quote token.");
  }
  if (gasEval.ok && nativeRaw < (gasEval.cost?.costWei || 0n)) {
    reasons.push(
      `Native ${nativeSymbolFor(chainConfig)} balance is below the estimated gas cost.`,
    );
  }
  if (reasons.length) {
    const warnings = [...securityEval.warnings, gasEval.warning].filter(Boolean);
    return {
      text: abortText("guardrail failed", reasons, warnings),
      replyMarkup: null,
    };
  }

  const id = newId();
  const session = {
    id,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    owner,
    chain: chainConfig.key,
    chainId: config.chainId,
    chainConfig,
    nativeSymbol: nativeSymbolFor(chainConfig),
    baseAddress: token,
    baseSymbol,
    baseDecimals,
    quoteAddress,
    quoteSymbol,
    quoteDecimals,
    baseIsToken0,
    basePriceInQuote,
    baseUsdPrice,
    quoteUsdPrice,
    nativeUsdPrice,
    pool: resolved.pool,
    fee: resolved.fee ?? state.fee,
    tick: state.tick,
    tickSpacing: state.tickSpacing,
    state,
    security,
    balances: {
      baseRaw,
      quoteRaw,
      nativeRaw,
      baseHuman: Number(formatUnits(baseRaw, baseDecimals)),
      quoteHuman: Number(formatUnits(quoteRaw, quoteDecimals)),
    },
    budgetUsd: Number(deploy.amountUsd) || 100,
    maxGasFeeUsd: Number(deploy.maxGasFeeUsd) || 0.5,
    guardrails: {
      securityChecks: securityEval.checks,
      securityWarnings: securityEval.warnings,
      warnings: [...securityEval.warnings, gasEval.warning].filter(Boolean),
      gas: gasEval,
      gasPriceWei,
    },
    side: null,
    rangeKey: null,
    plan: null,
  };

  sessions.set(id, session);
  log(
    "panda",
    `Deploy session ${id} opened for ${baseSymbol}/${quoteSymbol} on ${chainConfig.key} `
    + `by ${shortAddress(owner)}`,
  );
  return { text: guardrailText(session), replyMarkup: step1Keyboard(session) };
}


// ─── Step 3: quote, gas re-check, allowance ──────────────────────────

function rawAmount(amount, decimals) {
  const value = Math.max(0, Number(amount) || 0);
  const digits = Math.min(Math.max(0, Number(decimals) || 0), 8);
  return parseUnits(value.toFixed(digits), decimals);
}

async function estimateMintGas({ client, config, plan, missingApprovals }) {
  const deploy = config.deploy || {};
  const fallback = Number(deploy.gasLimitEstimate || 450_000)
    + missingApprovals * Number(deploy.approveGasLimitEstimate || 60_000);
  try {
    const data = encodeMintCalldata(plan.params);
    const gas = await client.provider.estimateGas({
      from: plan.owner,
      to: config.positionManager,
      data,
    });
    return Number(gas);
  } catch (error) {
    log("panda_warn", `mint gas estimate failed (using fallback): ${error.message}`);
    return fallback;
  }
}

/**
 * Build the complete deposit plan for a chosen side + range:
 * tick bounds, USD allocation capped by balances, raw mint amounts, allowance
 * requirements, fresh gas estimate and ABI-encoded calldata.
 */
export async function buildDeploymentPlan(ctx, session, side, rangeKey) {
  const config = ctx.config;
  const client = ctx.router.get(session.chain);
  const state = await client.getPoolState(session.pool, { refresh: true });
  const range = DEPLOY_RANGES[rangeKey];
  if (!range) throw new Error(`Unknown range selection: ${rangeKey}`);

  const ticks = computeTickRange({
    tick: state.tick,
    tickSpacing: state.tickSpacing,
    rangePct: range.pct,
    side,
    baseIsToken0: session.baseIsToken0,
  });
  const prices = rangePriceBounds({
    ...ticks,
    decimals0: state.decimals0,
    decimals1: state.decimals1,
    baseIsToken0: session.baseIsToken0,
  });

  const allocation = allocateDeployAmounts({
    side,
    budgetUsd: session.budgetUsd,
    baseUsdPrice: session.baseUsdPrice,
    quoteUsdPrice: session.quoteUsdPrice,
    baseBalance: session.balances.baseHuman,
    quoteBalance: session.balances.quoteHuman,
  });

  if (allocation.totalUsd < Number(config.deploy?.minAmountUsd || 1)) {
    throw new Error(
      `Estimated deposit ${formatUsd(allocation.totalUsd)} is below the minimum `
      + `${formatUsd(config.deploy?.minAmountUsd || 1)}.`,
    );
  }
  if (side === "base" && allocation.baseAmount <= 0) {
    throw new Error(`Wallet has no ${session.baseSymbol} available for a base-side deploy.`);
  }
  if (side === "quote" && allocation.quoteAmount <= 0) {
    throw new Error(`Wallet has no ${session.quoteSymbol} available for a quote-side deploy.`);
  }
  if (side === "dual" && (allocation.baseAmount <= 0 || allocation.quoteAmount <= 0)) {
    throw new Error("Dual 50:50 requires a balance of both tokens.");
  }

  const amount0Human = session.baseIsToken0 ? allocation.baseAmount : allocation.quoteAmount;
  const amount1Human = session.baseIsToken0 ? allocation.quoteAmount : allocation.baseAmount;
  const amount0Desired = rawAmount(amount0Human, state.decimals0);
  const amount1Desired = rawAmount(amount1Human, state.decimals1);
  if (amount0Desired <= 0n && amount1Desired <= 0n) {
    throw new Error("Computed deposit is zero; increase DEPLOY_AMOUNT_USD or fund the wallet.");
  }
  return finishDeploymentPlan(ctx, {
    session, client, state, side, range, ticks, prices, allocation,
    amount0Desired, amount1Desired,
  });
}


async function finishDeploymentPlan(ctx, data) {
  const {
    session, client, state, side, range, ticks, prices, allocation,
    amount0Desired, amount1Desired,
  } = data;
  const config = ctx.config;

  const requirements = [];
  if (amount0Desired > 0n) {
    requirements.push({
      token: state.token0,
      symbol: state.token0Symbol,
      amount: amount0Desired,
    });
  }
  if (amount1Desired > 0n) {
    requirements.push({
      token: state.token1,
      symbol: state.token1Symbol,
      amount: amount1Desired,
    });
  }
  const [balance0, balance1, allowance0, allowance1] = await Promise.all([
    readBalance(client, state.token0, session.owner),
    readBalance(client, state.token1, session.owner),
    readAllowance(client, state.token0, session.owner),
    readAllowance(client, state.token1, session.owner),
  ]);
  const allowanceCheck = evaluateAllowances({
    requirements,
    balances: {
      [String(state.token0).toLowerCase()]: balance0,
      [String(state.token1).toLowerCase()]: balance1,
    },
    allowances: {
      [String(state.token0).toLowerCase()]: allowance0,
      [String(state.token1).toLowerCase()]: allowance1,
    },
  });
  if (!allowanceCheck.ok) {
    const details = allowanceCheck.insufficient.map((entry) => (
      `${entry.symbol || shortAddress(entry.token)} balance is insufficient.`
    ));
    throw new Error(details.join(" "));
  }

  const deadline = Math.floor(Date.now() / 1_000)
    + Math.max(60, Number(config.deploy?.deadlineSec) || 1_200);
  const params = buildMintParams({
    token0: state.token0,
    token1: state.token1,
    fee: state.fee,
    tickLower: ticks.tickLower,
    tickUpper: ticks.tickUpper,
    amount0Desired,
    amount1Desired,
    recipient: session.owner,
    deadline,
    slippageBps: config.deploy?.slippageBps ?? 100,
  });
  const calldata = encodeMintCalldata(params);
  const gasLimit = await estimateMintGas({
    client,
    config,
    plan: { params, owner: session.owner },
    missingApprovals: allowanceCheck.missing.length,
  });
  const gasPriceWei = await readGasPrice(client).catch(() => null);
  const gasEval = evaluateGas({
    gasPriceWei,
    gasLimit,
    nativeUsdPrice: session.nativeUsdPrice,
    maxGasFeeUsd: session.maxGasFeeUsd,
  });
  if (!gasEval.ok) throw new Error(gasEval.reason || "Gas price guardrail failed.");

  const plan = {
    side,
    rangeKey: range.key,
    rangePct: range.pct,
    tickLower: ticks.tickLower,
    tickUpper: ticks.tickUpper,
    tickSpacing: ticks.tickSpacing,
    priceLower: prices.priceLower,
    priceUpper: prices.priceUpper,
    token0: state.token0,
    token1: state.token1,
    fee: state.fee,
    decimals0: state.decimals0,
    decimals1: state.decimals1,
    slippageBps: Number(config.deploy?.slippageBps ?? 100),
    baseAmount: allocation.baseAmount,
    quoteAmount: allocation.quoteAmount,
    baseUsd: allocation.baseUsd,
    quoteUsd: allocation.quoteUsd,
    totalUsd: allocation.totalUsd,
    capped: allocation.capped,
    amount0Desired,
    amount1Desired,
    requirements,
    missingApprovals: allowanceCheck.missing,
    allowanceCheck,
    gasLimit,
    gasPriceWei,
    gas: gasEval,
    params,
    calldata,
    deadline,
    owner: session.owner,
  };

  session.side = side;
  session.rangeKey = range.key;
  session.plan = plan;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return plan;
}

function confirmationText(session, plan) {
  const approvals = plan.missingApprovals.length
    ? plan.missingApprovals
      .map((entry) => entry.symbol || shortAddress(entry.token))
      .join(" + ")
    : "none";
  return [
    `<b>Step 3/3 — Confirm deployment</b>`,
    `Pair: <b>${escapeHtml(session.baseSymbol)}/${escapeHtml(session.quoteSymbol)}</b>`
    + ` on ${escapeHtml(session.chain)}`,
    `Side: ${sideText(session)} | Range: ${rangeText(session)}`,
    `Ticks: <code>${plan.tickLower}</code> → <code>${plan.tickUpper}</code>`
    + ` (spacing ${plan.tickSpacing})`,
    `Price: ${formatPrice(plan.priceLower)} → ${formatPrice(plan.priceUpper)}`
    + ` ${escapeHtml(session.quoteSymbol)} per ${escapeHtml(session.baseSymbol)}`,
    "",
    `<b>Estimated deposit</b>`,
    `${formatAmount(plan.baseAmount, session.baseDecimals)} ${escapeHtml(session.baseSymbol)}`
    + ` (${formatUsd(plan.baseUsd)})`,
    `${formatAmount(plan.quoteAmount, session.quoteDecimals)} ${escapeHtml(session.quoteSymbol)}`
    + ` (${formatUsd(plan.quoteUsd)})`,
    `Total ≈ ${formatUsd(plan.totalUsd)}${plan.capped ? " (capped by wallet balance)" : ""}`,
    "",
    `Approval needed: <b>${escapeHtml(approvals)}</b>`,
    `Gas limit: ${plan.gasLimit.toLocaleString("en-US")} | `
    + `cost ${plan.gas.cost.native.toFixed(8)} ${escapeHtml(session.nativeSymbol)}`
    + ` ≈ ${formatUsd(plan.gas.cost.usd)}`,
    `Slippage: ${(Number(plan.slippageBps) / 100).toFixed(2)}%`,
    "",
    `<i>Confirming signs and broadcasts the mint transaction with `
    + `WALLET_PRIVATE_KEY. Nothing is sent before this tap.</i>`,
  ].join("\n");
}


// ─── Mint execution + post-deployment management card ────────────────

function findTokenId(receipt, client) {
  for (const entry of receipt.logs || []) {
    try {
      const parsed = client.npm.interface.parseLog(entry);
      if (parsed?.name === "IncreaseLiquidity") return parsed.args.tokenId.toString();
    } catch {
      // Logs from other contracts are ignored.
    }
  }
  return null;
}

async function executeDeployment(ctx, session) {
  const config = ctx.config;
  const plan = session.plan;
  if (!plan) throw new Error("No confirmed deposit plan for this session.");
  const client = ctx.router.get(session.chain);

  let tokenId = null;
  let txHash = null;
  let shadow = true;

  if (!config.dryRun) {
    if (!client.signer) {
      throw new Error("Live deployment requires WALLET_PRIVATE_KEY and DRY_RUN=false.");
    }
    if (config.deploy?.dryRun) {
      throw new Error("Deployment is disabled by config.deploy.dryRun.");
    }
    // Re-read balances right before approvals; wallet state may have changed.
    for (const requirement of plan.requirements) {
      const balance = await readBalance(client, requirement.token, session.owner);
      if (balance < BigInt(requirement.amount)) {
        throw new Error(
          `${requirement.symbol || shortAddress(requirement.token)} balance changed; `
          + "restart /deploy to re-quote.",
        );
      }
      await client.ensureAllowance(requirement.token, requirement.amount);
    }

    const npm = client.npm.connect(client.signer);
    const tx = await npm.mint(plan.params);
    const receipt = await tx.wait();
    txHash = receipt.hash;
    tokenId = findTokenId(receipt, client);
    shadow = false;
    if (!tokenId) {
      log("panda_warn", `Mint ${txHash} succeeded but no IncreaseLiquidity tokenId was found.`);
    }
  }

  const automationId = newId();
  const automation = {
    id: automationId,
    chain: session.chain,
    chainId: session.chainId,
    pool: session.pool,
    tokenId: tokenId || `shadow-${automationId}`,
    shadow,
    token0: plan.token0,
    token1: plan.token1,
    token0Symbol: session.state.token0Symbol,
    token1Symbol: session.state.token1Symbol,
    baseAddress: session.baseAddress,
    quoteAddress: session.quoteAddress,
    baseSymbol: session.baseSymbol,
    quoteSymbol: session.quoteSymbol,
    baseIsToken0: session.baseIsToken0,
    fee: plan.fee,
    entryPrice: session.basePriceInQuote,
    entryTick: session.tick,
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    priceLower: plan.priceLower,
    priceUpper: plan.priceUpper,
    side: plan.side,
    rangePct: plan.rangePct,
    baseAmount: formatAmount(plan.baseAmount, session.baseDecimals),
    quoteAmount: formatAmount(plan.quoteAmount, session.quoteDecimals),
    amountUsd: plan.totalUsd,
    alertIntervalMin: 15,
    takeProfitPct: Number(config.risk?.takeProfitPct ?? 25),
    stopLossPct: Number(config.risk?.stopLossPct ?? -50),
    autoCloseOutOfRange: false,
    status: "open",
    txHash,
    createdAt: new Date().toISOString(),
    lastAlertAt: null,
  };
  upsertAutomation(automation, { filePath: automationFilePath(config) });

  if (Array.isArray(ctx.positions)) {
    ctx.positions.push({
      label: `deploy-${tokenId || automationId}`,
      chain: session.chain,
      chainId: session.chainId,
      pool: session.pool,
      tokenId,
      token0: plan.token0,
      token1: plan.token1,
      baseToken: session.baseAddress,
      fee: plan.fee,
      amountUsd: plan.totalUsd,
      notes: "created via /deploy",
      state: { ...session.state, tickLower: plan.tickLower, tickUpper: plan.tickUpper },
      onchain: {
        ...session.state,
        tickLower: plan.tickLower,
        tickUpper: plan.tickUpper,
      },
    });
  }

  log(
    "panda",
    `Deployed ${session.baseSymbol}/${session.quoteSymbol} on ${session.chain} `
    + `${shadow ? "(shadow)" : `tokenId=${tokenId} tx=${txHash}`} `
    + `range=${plan.tickLower}..${plan.tickUpper}`,
  );

  const header = shadow
    ? "<b>✅ Shadow deployment simulated</b>\nNo transaction was broadcast (DRY_RUN=true).\n\n"
    : `<b>✅ LP position minted</b>\nNFT <code>${escapeHtml(tokenId || "unknown")}</code>`
      + ` | tx <code>${escapeHtml(shortAddress(txHash))}</code>\n`;
  return {
    text: header + formatManagementCard(automation),
    replyMarkup: managementKeyboard(automation),
    automation,
  };
}


// ─── Inline menu callback state machine ──────────────────────────────

function sessionExpiredReply() {
  return {
    text: "This deployment menu expired. Send <code>/deploy &lt;token_address&gt;</code> again.",
    replyMarkup: null,
    edit: true,
    answer: "Session expired",
  };
}

function step2Text(session) {
  return [
    `<b>Step 2/3 — Choose a range</b>`,
    `${escapeHtml(session.baseSymbol)}/${escapeHtml(session.quoteSymbol)}`
    + ` | ${sideText(session)}`,
    `Spot: ${formatPrice(session.basePriceInQuote)} ${escapeHtml(session.quoteSymbol)}`
    + ` per ${escapeHtml(session.baseSymbol)} (tick ${session.tick})`,
    "",
    "Narrow ±2% · Moderate ±5% · Wide ±15%",
    session.side === "dual"
      ? "<i>Dual deposits use the same budget split around spot.</i>"
      : "<i>Single-side ranges are anchored above or below spot so only the selected token is deposited.</i>",
  ].join("\n");
}

/** Dispatch an inline callback beginning with `dp:`. */
export async function handleDeployCallback(ctx, data, callbackQuery = {}) {
  const parts = String(data || "").split(":");
  const action = parts[1];
  const value = parts.length > 3 ? parts[2] : null;
  const id = parts[parts.length - 1];
  const session = getDeploySession(id);
  if (!session) return sessionExpiredReply();

  if (action === "z") {
    sessions.delete(id);
    return {
      text: "<b>Deployment cancelled.</b>\nNo approval or transaction was sent.",
      replyMarkup: null,
      edit: true,
      answer: "Cancelled",
    };
  }

  if (action === "s") {
    if (!DEPLOY_SIDES[value]) {
      return { text: "Unknown side selection.", replyMarkup: step1Keyboard(session), edit: true };
    }
    session.side = value;
    return {
      text: step2Text(session),
      replyMarkup: step2Keyboard(session),
      edit: true,
      answer: DEPLOY_SIDES[value].label,
    };
  }

  if (action === "b") {
    if (value === "2") {
      return {
        text: step2Text(session),
        replyMarkup: step2Keyboard(session),
        edit: true,
        answer: "Back",
      };
    }
    session.plan = null;
    session.side = null;
    session.rangeKey = null;
    return {
      text: guardrailText(session),
      replyMarkup: step1Keyboard(session),
      edit: true,
      answer: "Back",
    };
  }

  if (action === "r") {
    if (!DEPLOY_RANGES[value] || !session.side) {
      return {
        text: "Select a side before choosing a range.",
        replyMarkup: step1Keyboard(session),
        edit: true,
      };
    }
    try {
      const plan = await buildDeploymentPlan(ctx, session, session.side, value);
      return {
        text: confirmationText(session, plan),
        replyMarkup: confirmKeyboard(session),
        edit: true,
        answer: DEPLOY_RANGES[value].label,
      };
    } catch (error) {
      return {
        text: abortText("planning failed", [error?.message || String(error)]),
        replyMarkup: step2Keyboard(session),
        edit: true,
        answer: "Guardrail failed",
      };
    }
  }

  if (action === "m") {
    if (!session.plan) {
      return {
        text: "No plan to confirm; choose a range again.",
        replyMarkup: step2Keyboard(session),
        edit: true,
        answer: "Nothing to confirm",
      };
    }
    try {
      const result = await executeDeployment(ctx, session);
      sessions.delete(id);
      return {
        text: result.text,
        replyMarkup: result.replyMarkup,
        edit: true,
        answer: result.automation.shadow ? "Shadow mint simulated" : "LP position minted",
      };
    } catch (error) {
      return {
        text: abortText("mint failed", [error?.message || String(error)]),
        replyMarkup: confirmKeyboard(session),
        edit: true,
        answer: "Mint failed",
      };
    }
  }

  return sessionExpiredReply();
}


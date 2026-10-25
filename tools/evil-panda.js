// ─── Evil Panda Strategy Module (EVM port) ─────────────────────────
// Exit engine: RSI(2) + Bollinger Band penetration + MACD shift confluence.
// Price pipeline: GeckoTerminal/DexScreener EVM endpoints -> Uniswap v3
// slot0 active price -> in-memory 50-sample buffer.

import { log } from "../logger.js";

const GECKO_API = "https://api.geckoterminal.com/api/v2";
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";

const DEFAULTS = {
  bufferSize: 50,
  bufferMaxAgeMs: 30 * 60_000,
  staleSeriesMaxMs: 30 * 60_000,
  degradedCacheMs: 10_000,
  geckoCooldownMs: 60_000,
  fetchTimeoutMs: 8_000,
  resolvedTokenCacheMs: 10 * 60_000,
  minCandles: 35,
};

const PRICE_SERIES_CACHE = new Map();
const PRICE_SERIES_CACHE_MAX = 200;
/** poolKey -> number[] (oldest -> newest, capped at bufferSize) */
const inMemoryPriceBuffers = new Map();
/** poolKey -> number[] sample timestamps (parallel to the buffer) */
const priceBufferTimes = new Map();
/** poolKey -> source tag so incompatible price units never mix */
const priceBufferSources = new Map();
/** poolKey -> { tokenAddress, at } */
const resolvedTokenCache = new Map();
/** poolKey -> epoch ms until which GeckoTerminal is skipped */
const geckoCooldownUntil = new Map();
/** poolKey -> epoch ms of the last fallback-failure log */
const spotErrorLoggedAt = new Map();

/**
 * Calculate RSI (Relative Strength Index).
 * Identical math to the reference module, including the flat-window neutral 50.
 */
export function calculateRSI(prices, period = 2) {
  try {
    if (!prices || prices.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = prices[prices.length - i] - prices[prices.length - i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    // No movement at all is neutral (50), not overbought (100).
    if (gains === 0 && losses === 0) return 50;
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  } catch (error) {
    log("error", `Error calculating RSI: ${error.message}`);
    return null;
  }
}

/** Calculate Bollinger Bands (population standard deviation). */
export function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  try {
    if (!prices || prices.length < period) return null;
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[prices.length - 1 - i];
    }
    const sma = sum / period;
    let squaredDeviations = 0;
    for (let i = 0; i < period; i++) {
      const deviation = prices[prices.length - 1 - i] - sma;
      squaredDeviations += deviation * deviation;
    }
    const stdDeviation = Math.sqrt(squaredDeviations / period);
    return {
      sma,
      upperBand: sma + (stdDev * stdDeviation),
      lowerBand: sma - (stdDev * stdDeviation),
      stdDeviation,
    };
  } catch (error) {
    log("error", `Error calculating Bollinger Bands: ${error.message}`);
    return null;
  }
}

function calculateEMA(prices, period) {
  try {
    if (!prices || prices.length < period) return [];
    const multiplier = 2 / (period + 1);
    const emaValues = [];
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[prices.length - period + i];
    }
    let ema = sum / period;
    emaValues.push(ema);
    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
      emaValues.push(ema);
    }
    return emaValues;
  } catch (error) {
    log("error", `Error calculating EMA: ${error.message}`);
    return [];
  }
}

/**
 * Calculate MACD. Ported verbatim from the reference module so the exit
 * behaviour matches the reference implementation.
 */
export function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  try {
    if (!prices || prices.length < slowPeriod + signalPeriod) return null;
    const fastEMA = calculateEMA(prices, fastPeriod);
    const slowEMA = calculateEMA(prices, slowPeriod);
    if (fastEMA.length < 1 || slowEMA.length < 1) return null;

    const macdLine = fastEMA[fastEMA.length - 1] - slowEMA[slowEMA.length - 1];
    const macdLineArray = fastEMA.slice(-signalPeriod).map((_, i) =>
      fastEMA[fastEMA.length - signalPeriod + i] - slowEMA[slowEMA.length - signalPeriod + i],
    );
    const signalLine = calculateEMA(macdLineArray, signalPeriod)[0];
    const histogram = macdLine - signalLine;

    return { macdLine, signalLine, histogram };
  } catch (error) {
    log("error", `Error calculating MACD: ${error.message}`);
    return null;
  }
}

/**
 * Evil Panda confluence exit.
 *
 * Reference engine: exit when RSI is overbought AND at least one of
 * (price >= upper Bollinger Band, MACD histogram positive). This port keeps
 * that confluence shape, with the overbought threshold configurable in the
 * documented 70-80 band (default 80).
 *
 * @param {number[]} prices ascending close prices, oldest -> newest
 * @param {number} [currentPrice] live price; defaults to last close
 * @param {Object} [options]
 */
export function checkEvilPandaExitConfluence(prices, currentPrice, options = {}) {
  const opts = {
    rsiPeriod: options.rsiPeriod ?? 2,
    rsiOverbought: options.rsiOverbought ?? 80,
    bbPeriod: options.bbPeriod ?? 20,
    bbStdDev: options.bbStdDev ?? 2,
    macdFast: options.macdFast ?? 12,
    macdSlow: options.macdSlow ?? 26,
    macdSignal: options.macdSignal ?? 9,
    confluenceMode: options.confluenceMode ?? "any",
    requireMacdShift: options.requireMacdShift ?? false,
    minCandles: options.minCandles ?? 35,
  };

  const neutral = {
    shouldExit: false,
    reason: "",
    rsi: null,
    bbUpper: null,
    macdHistogram: null,
    macdShift: false,
    rsiTriggered: false,
    bbTriggered: false,
    macdTriggered: false,
  };

  try {
    if (!Array.isArray(prices) || prices.length < opts.minCandles) {
      return {
        ...neutral,
        reason: `Insufficient price history (${prices?.length ?? 0} < ${opts.minCandles})`,
      };
    }

    const price = Number.isFinite(Number(currentPrice))
      ? Number(currentPrice)
      : prices[prices.length - 1];

    const rsi = calculateRSI(prices, opts.rsiPeriod);
    const bb = calculateBollingerBands(prices, opts.bbPeriod, opts.bbStdDev);
    const macd = calculateMACD(prices, opts.macdFast, opts.macdSlow, opts.macdSignal);

    if (rsi === null || !bb || !macd) {
      return { ...neutral, reason: "Failed to calculate indicators" };
    }

    // MACD shift = histogram crosses from <= 0 to > 0 this candle.
    const previousMacd = calculateMACD(
      prices.slice(0, -1),
      opts.macdFast,
      opts.macdSlow,
      opts.macdSignal,
    );
    const previousHistogram = previousMacd?.histogram ?? null;
    const macdShift = macd.histogram > 0
      && (previousHistogram == null || previousHistogram <= 0);

    const rsiTriggered = rsi >= opts.rsiOverbought;
    // σ=0 is a flat window where price sits exactly on both bands — never an exit.
    const bbTriggered = bb.stdDeviation > 0 && price >= bb.upperBand;
    const macdTriggered = opts.requireMacdShift ? macdShift : macd.histogram > 0;

    const confluence = opts.confluenceMode === "all"
      ? rsiTriggered && bbTriggered && macdTriggered
      : rsiTriggered && (bbTriggered || macdTriggered);

    const confirmations = [
      bbTriggered ? "BB penetration" : null,
      opts.requireMacdShift
        ? (macdShift ? "MACD shift" : null)
        : (macd.histogram > 0 ? "MACD histogram > 0" : null),
    ].filter(Boolean);

    return {
      shouldExit: confluence,
      rsi,
      bbUpper: bb.upperBand,
      macdHistogram: macd.histogram,
      macdShift,
      rsiTriggered,
      bbTriggered,
      macdTriggered,
      reason: confluence
        ? `EXIT CONFLUENCE HIT: RSI(${opts.rsiPeriod})=${rsi.toFixed(2)} (>= ${opts.rsiOverbought}) with ${confirmations.join(" + ")}`
        : `Hold position (RSI=${rsi.toFixed(2)}, BB=${bbTriggered ? "penetrated" : "inside"}, MACD=${macd.histogram > 0 ? "positive" : "negative"})`,
    };
  } catch (error) {
    log("error", `Error checking Evil Panda exit: ${error.message}`);
    return { ...neutral, reason: error.message };
  }
}

/**
 * 3-tick confirmation poller (in-memory port of the reference state module
 * registerExitSignal). An exit only fires after `confirmTicks` consecutive
 * polls report the SAME signal. The streak resets when the signal clears or
 * changes.
 */
export function createExitConfirmation(confirmTicks = 3) {
  const required = Math.max(1, Math.floor(Number(confirmTicks) || 3));
  const pending = new Map();

  function clear(key) {
    pending.delete(key);
  }

  return {
    required,
    /**
     * @param {string} key position identifier
     * @param {string|null} signal exit signal for this poll, null when none
     * @returns {{fire:boolean, action:string|null, count:number, required:number}}
     */
    confirm(key, signal) {
      if (!signal) {
        clear(key);
        return { fire: false, action: null, count: 0, required };
      }
      const previous = pending.get(key);
      const count = previous && previous.action === signal ? previous.count + 1 : 1;
      if (count >= required) {
        clear(key);
        return { fire: true, action: signal, count, required };
      }
      pending.set(key, { action: signal, count });
      return { fire: false, action: signal, count, required };
    },
    peek(key) {
      return pending.get(key) || null;
    },
    reset: clear,
    resetAll() {
      pending.clear();
    },
    get size() {
      return pending.size;
    },
  };
}

function geckoOhlcvPath(timeframe) {
  const tf = String(timeframe || "5m").trim().toLowerCase();
  const unit = tf.endsWith("h") ? "hour" : "minute";
  const aggregated = parseInt(tf, 10);
  const aggregate = Number.isFinite(aggregated) && aggregated > 0
    ? aggregated
    : (unit === "hour" ? 1 : 5);
  return { unit, aggregate };
}

function poolKey(chain, poolAddress) {
  return `${String(chain || "").toLowerCase()}:${String(poolAddress || "").toLowerCase()}`;
}

function emptySeries(timeframe, source = "unavailable") {
  return {
    prices: [],
    candles: [],
    currentPrice: null,
    timeframe,
    source,
    fetchedAt: new Date().toISOString(),
  };
}

function toSpotPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function cachePriceSeries(cacheKey, value, ttlMs) {
  PRICE_SERIES_CACHE.set(cacheKey, { at: Date.now(), ttlMs: Math.max(0, ttlMs), value });
  if (PRICE_SERIES_CACHE.size > PRICE_SERIES_CACHE_MAX) {
    const oldest = [...PRICE_SERIES_CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) PRICE_SERIES_CACHE.delete(oldest);
  }
}

function logSpotFailure(key, message, settings) {
  const now = Date.now();
  if (now - (spotErrorLoggedAt.get(key) || 0) < settings.geckoCooldownMs) return;
  spotErrorLoggedAt.set(key, now);
  log("panda_warn", message);
}

/** Snapshot of the in-memory fallback price buffer for a pool + base token. */
export function getInMemoryPriceBuffer(chain, poolAddress, baseToken = null) {
  const key = `${poolKey(chain, poolAddress)}:${String(baseToken || "default").toLowerCase()}`;
  return [...(inMemoryPriceBuffers.get(key) || [])];
}

/** Fetch JSON with a hard timeout so a slow API can't stall the poller. */
async function fetchJson(url, settings) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1_000, Number(settings.fetchTimeoutMs) || DEFAULTS.fetchTimeoutMs),
  );
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GeckoTerminal OHLCV for an EVM network (arbitrum | base).
 *
 * GeckoTerminal always returns candles denominated in USD of the pool's
 * *base token*, and it may choose the quote token as its base (e.g. USDC for
 * USDC/WETH). A series for the wrong token is worse than no series, so when
 * `requestedBaseToken` is known we require Gecko's base to match it and fall
 * through to the spot fallbacks otherwise.
 */
async function fetchGeckoCandles(chain, poolAddress, timeframe, limit, settings, requestedBaseToken = null) {
  const { unit, aggregate } = geckoOhlcvPath(timeframe);
  const network = String(chain || "").toLowerCase();
  const url = `${GECKO_API}/networks/${encodeURIComponent(network)}/pools/${poolAddress}/ohlcv/${unit}`
    + `?aggregate=${aggregate}&limit=${limit}`;
  const payload = await fetchJson(url, settings);
  const rows = payload?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty ohlcv_list");

  const geckoBase = String(payload?.meta?.base?.address || "").toLowerCase();
  const geckoQuote = String(payload?.meta?.quote?.address || "").toLowerCase();
  const wanted = String(requestedBaseToken || "").toLowerCase();
  if (wanted && geckoBase && geckoBase !== wanted) {
    const baseSymbol = payload?.meta?.base?.symbol || geckoBase.slice(0, 8);
    if (geckoQuote === wanted) {
      throw new Error(
        `GeckoTerminal candles are USD(${baseSymbol}), not the requested base token`,
      );
    }
    throw new Error(
      `GeckoTerminal base token ${baseSymbol} does not match the requested base token`,
    );
  }

  const candles = rows
    .map((row) => ({
      time: Number(row?.[0]),
      open: Number(row?.[1]),
      high: Number(row?.[2]),
      low: Number(row?.[3]),
      close: Number(row?.[4]),
      volume: Number(row?.[5]),
    }))
    .filter((candle) => Number.isFinite(candle.time)
      && Number.isFinite(candle.close)
      && candle.close > 0)
    .sort((a, b) => a.time - b.time);

  if (candles.length < settings.minCandles) {
    throw new Error(`insufficient candles (${candles.length} < ${settings.minCandles})`);
  }
  return candles;
}

/**
 * Pick the pair that actually belongs to the pool. When a pool address is
 * supplied we require an exact pairAddress match — DexScreener's token
 * endpoint returns every pair for a token and their prices can diverge.
 */
function pickDexPair(pairs, poolAddress, chain) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const wantedChain = String(chain || "").toLowerCase();
  const onChain = wantedChain
    ? pairs.filter((pair) => !pair?.chainId || String(pair.chainId).toLowerCase() === wantedChain)
    : pairs;
  const candidates = onChain.length ? onChain : pairs;
  const target = String(poolAddress || "").toLowerCase();
  if (target) {
    const exact = candidates.find(
      (pair) => String(pair?.pairAddress || "").toLowerCase() === target,
    );
    if (exact) return exact;
  }
  // With no exact pool match only a single unambiguous pair is trustworthy.
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Normalize a DexScreener pair to the USD price of `requestedToken`.
 * DexScreener's priceUsd is the base token's price; when the requested token
 * is the pair's quote token we derive its USD price as priceUsd / priceNative.
 */
function spotFromDexPair(pair, requestedToken = null) {
  if (!pair) return null;
  const baseAddress = String(pair?.baseToken?.address || "").toLowerCase();
  const quoteAddress = String(pair?.quoteToken?.address || "").toLowerCase();
  const wanted = String(requestedToken || "").toLowerCase();
  const priceUsd = toSpotPrice(pair?.priceUsd);
  const priceNative = toSpotPrice(pair?.priceNative);

  // The pair must actually contain the requested token.
  if (wanted && baseAddress && quoteAddress
    && wanted !== baseAddress && wanted !== quoteAddress) {
    return null;
  }

  let price = null;
  if (wanted && quoteAddress && quoteAddress === wanted && baseAddress !== wanted) {
    // Requested token is the quote: USD/quote = (USD/base) / (quote/base).
    if (priceUsd != null && priceNative != null) price = priceUsd / priceNative;
    else if (priceNative != null) price = 1 / priceNative;
  } else {
    price = priceUsd ?? priceNative;
  }
  if (price == null) return null;

  return {
    price,
    source: "dexscreener",
    tokenAddress: requestedToken || pair?.baseToken?.address || null,
    pairBaseToken: pair?.baseToken?.address || null,
    pairAddress: pair?.pairAddress || null,
  };
}

async function fetchDexScreenerTokenSpot(chain, tokenAddress, poolAddress, settings, requestedToken) {
  const payload = await fetchJson(
    `${DEXSCREENER_API}/tokens/${encodeURIComponent(tokenAddress)}`,
    settings,
  );
  return spotFromDexPair(pickDexPair(payload?.pairs, poolAddress, chain), requestedToken);
}

async function fetchDexScreenerPairsSpot(chain, poolAddress, settings, requestedToken) {
  const payload = await fetchJson(
    `${DEXSCREENER_API}/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(poolAddress)}`,
    settings,
  );
  const pairs = payload?.pairs || (payload?.pair ? [payload.pair] : []);
  return spotFromDexPair(pickDexPair(pairs, poolAddress, chain), requestedToken);
}

/**
 * DexScreener spot price. Uses the token endpoint when the base token is known
 * (explicit param or previously resolved), then falls back to the pool endpoint.
 */
async function fetchDexScreenerSpot({ chain, poolAddress, tokenAddress, settings }) {
  const key = poolKey(chain, poolAddress);
  const cachedToken = resolvedTokenCache.get(key);
  const knownToken = tokenAddress
    || (cachedToken && Date.now() - cachedToken.at < settings.resolvedTokenCacheMs
      ? cachedToken.tokenAddress
      : null);

  if (knownToken) {
    try {
      const tokenSpot = await fetchDexScreenerTokenSpot(
        chain,
        knownToken,
        poolAddress,
        settings,
        tokenAddress,
      );
      if (tokenSpot) return tokenSpot;
    } catch (error) {
      logSpotFailure(
        key,
        `DexScreener token price failed for ${poolAddress.slice(0, 10)}: ${error.message}`,
        settings,
      );
    }
  }

  const pairSpot = await fetchDexScreenerPairsSpot(chain, poolAddress, settings, tokenAddress);
  if (pairSpot?.pairBaseToken) {
    resolvedTokenCache.set(key, { tokenAddress: pairSpot.pairBaseToken, at: Date.now() });
  }
  return pairSpot;
}

/**
 * Append a spot price to the pool's sliding window.
 * A source change resets the window: USD prices (DexScreener) and slot0
 * quote-token prices are not interchangeable, so a series is always built from
 * one consistent unit.
 */
function appendInMemoryPrice(key, price, source, settings) {
  const value = toSpotPrice(price);
  if (!key || value == null) return inMemoryPriceBuffers.get(key) || [];

  if (priceBufferSources.get(key) !== source) {
    inMemoryPriceBuffers.set(key, []);
    priceBufferTimes.set(key, []);
    priceBufferSources.set(key, source);
  }

  const now = Date.now();
  const buffer = inMemoryPriceBuffers.get(key) || [];
  const times = priceBufferTimes.get(key) || [];

  buffer.push(value);
  times.push(now);

  // Cap the sliding window, then drop samples older than the max age so a
  // dormant buffer can never feed stale prices into an auto-close.
  if (buffer.length > settings.bufferSize) {
    const excess = buffer.length - settings.bufferSize;
    buffer.splice(0, excess);
    times.splice(0, excess);
  }
  const cutoff = now - settings.bufferMaxAgeMs;
  let staleCount = 0;
  while (staleCount < times.length && times[staleCount] < cutoff) staleCount++;
  if (staleCount > 0) {
    buffer.splice(0, staleCount);
    times.splice(0, staleCount);
  }

  inMemoryPriceBuffers.set(key, buffer);
  priceBufferTimes.set(key, times);
  return buffer;
}

/** Build an OHLCV-shaped series from the in-memory spot buffer. */
function buildBufferSeries(key, buffer, timeframe, settings) {
  const now = Date.now();
  const candles = buffer.map((close, index) => ({
    time: now - (buffer.length - 1 - index) * settings.degradedCacheMs,
    open: close,
    high: close,
    low: close,
    close,
    volume: null,
  }));
  return {
    prices: [...buffer],
    candles,
    currentPrice: buffer[buffer.length - 1],
    timeframe,
    source: `${priceBufferSources.get(key) || "spot"}+memory_buffer`,
    degraded: true,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch an ascending close-price series for a Uniswap v3 pool on Arbitrum,
 * Base, Ethereum, BNB Chain or Robinhood Chain.
 * Primary: GeckoTerminal OHLCV. Secondary: DexScreener spot. Tertiary: Uniswap
 * v3 slot0 active price provided by the caller. Fallback samples accumulate in
 * a 50-point in-memory buffer so indicators can still compute during an OHLCV
 * outage. Cached per (chain, pool, timeframe, limit); never throws.
 *
 * @param {Object} params
 * @param {string} params.chain                 canonical chain key (cache identity)
 * @param {string} [params.geckoNetwork]        GeckoTerminal network slug
 * @param {string} [params.dexscreenerChain]    DexScreener chain slug
 * @param {string} params.pool_address
 * @param {string} [params.token_address]       base token for DexScreener lookup
 * @param {string} [params.timeframe]
 * @param {number} [params.limit]
 * @param {number} [params.cacheSec]
 * @param {boolean} [params.refresh]
 * @param {() => Promise<number|{price:number}>} [params.getSlot0Price]
 * @param {Object} [params.settings]            config.priceFeed overrides
 */
export async function fetchPriceSeries({
  chain,
  geckoNetwork,
  dexscreenerChain,
  pool_address,
  poolAddress,
  token_address,
  tokenAddress,
  timeframe = "5m",
  limit = 120,
  cacheSec = 60,
  refresh = false,
  getSlot0Price = null,
  settings = {},
} = {}) {
  const network = String(chain || "").toLowerCase();
  const gecko = String(geckoNetwork || network).toLowerCase();
  const screener = String(dexscreenerChain || network).toLowerCase();
  const pool = String(pool_address || poolAddress || "").trim();
  const token = token_address || tokenAddress || null;
  const tf = String(timeframe || "5m").toLowerCase();
  const feed = { ...DEFAULTS, minCandles: 35, ...settings };

  if (!network || !pool) return emptySeries(tf, "missing_chain_or_pool");

  const requestedLimit = Math.max(feed.minCandles, Number(limit) || 120);
  // Buffer/cache key includes the requested base token: the same pool can be
  // monitored with different orientations, and those price units must never mix.
  const key = `${poolKey(network, pool)}:${String(token || "default").toLowerCase()}`;
  const cacheKey = `${key}:${tf}:${requestedLimit}`;
  const now = Date.now();
  const ttlMs = Math.max(0, Number(cacheSec) || 0) * 1_000;
  const cached = PRICE_SERIES_CACHE.get(cacheKey);
  if (!refresh && cached && now - cached.at < (cached.ttlMs ?? ttlMs)) return cached.value;

  // ── 1) Primary: GeckoTerminal OHLCV ─────────────────────────────
  const cooldownUntil = geckoCooldownUntil.get(key) || 0;
  if (refresh || now >= cooldownUntil) {
    try {
      const candles = await fetchGeckoCandles(gecko, pool, tf, requestedLimit, feed, token);
      const value = {
        prices: candles.map((candle) => candle.close),
        candles,
        currentPrice: candles[candles.length - 1].close,
        timeframe: tf,
        source: "geckoterminal",
        fetchedAt: new Date().toISOString(),
      };
      geckoCooldownUntil.delete(key);
      cachePriceSeries(cacheKey, value, ttlMs);
      return value;
    } catch (error) {
      geckoCooldownUntil.set(key, Date.now() + feed.geckoCooldownMs);
      logSpotFailure(
        key,
        `GeckoTerminal OHLCV unavailable for ${pool.slice(0, 10)} (${tf}): ${error.message}; using spot fallback`,
        feed,
      );
    }
  }

  // ── 2) Secondary: DexScreener spot ──────────────────────────────
  let spot = null;
  try {
    spot = await fetchDexScreenerSpot({
      chain: screener,
      poolAddress: pool,
      tokenAddress: token,
      settings: feed,
    });
  } catch (error) {
    logSpotFailure(
      key,
      `DexScreener spot failed for ${pool.slice(0, 10)}: ${error.message}`,
      feed,
    );
  }

  // ── 3) Tertiary: Uniswap v3 slot0 active price ──────────────────
  if (!spot && typeof getSlot0Price === "function") {
    try {
      const raw = await getSlot0Price();
      const price = toSpotPrice(raw?.price ?? raw);
      if (price != null) spot = { price, source: "slot0" };
    } catch (error) {
      logSpotFailure(
        key,
        `slot0 price failed for ${pool.slice(0, 10)}: ${error.message}`,
        feed,
      );
    }
  }

  // ── In-memory buffer: append this spot sample ───────────────────
  const buffer = spot
    ? appendInMemoryPrice(key, spot.price, spot.source, feed)
    : (inMemoryPriceBuffers.get(key) || []);

  // A buffer that hasn't received a fresh sample recently is not a valid
  // fallback — never let dormant prices feed the exit engine.
  const bufferTimes = priceBufferTimes.get(key) || [];
  const lastSampleAt = bufferTimes[bufferTimes.length - 1] || 0;
  const usableBuffer = buffer.length > 0 && now - lastSampleAt <= feed.bufferMaxAgeMs
    ? buffer
    : [];

  const bufferValue = usableBuffer.length > 0
    ? buildBufferSeries(key, usableBuffer, tf, feed)
    : null;
  const staleValue = cached?.value?.prices?.length
    && !cached.value.degraded
    && now - cached.at <= feed.staleSeriesMaxMs
    ? { ...cached.value, stale: true }
    : null;

  // Prefer fresh buffer data; if it cannot yet support the indicators and a
  // usable stale OHLCV series exists, serve that instead.
  let value;
  if (bufferValue && (usableBuffer.length >= feed.minCandles || !staleValue)) {
    value = bufferValue;
  } else if (staleValue) {
    value = staleValue;
  } else if (bufferValue) {
    value = bufferValue;
  } else {
    value = emptySeries(tf);
  }

  // Re-poll fallbacks frequently so the buffer keeps filling; cache the empty
  // result too, so a total outage cannot hammer the APIs every tick.
  const degradedTtl = Math.min(ttlMs > 0 ? ttlMs : feed.degradedCacheMs, feed.degradedCacheMs);
  cachePriceSeries(cacheKey, value, degradedTtl);
  return value;
}

/** Diagnostics for the health endpoint. */
export function getPriceSeriesCacheStats() {
  return {
    cachedSeries: PRICE_SERIES_CACHE.size,
    trackedPools: inMemoryPriceBuffers.size,
    buffers: [...inMemoryPriceBuffers.entries()].map(([key, buffer]) => ({
      pool: key,
      samples: buffer.length,
      source: priceBufferSources.get(key) || null,
      lastSampleAt: priceBufferTimes.get(key)?.at(-1) || null,
    })),
  };
}

/** Clear caches/buffers (used by tests). */
export function clearPriceSeriesCaches() {
  PRICE_SERIES_CACHE.clear();
  inMemoryPriceBuffers.clear();
  priceBufferTimes.clear();
  priceBufferSources.clear();
  resolvedTokenCache.clear();
  geckoCooldownUntil.clear();
  spotErrorLoggedAt.clear();
}

/** Human-readable summary of the active exit engine. */
export function describeExitEngine(panda) {
  return [
    `RSI(${panda.rsiPeriod}) >= ${panda.rsiOverbought}`,
    `BB(${panda.bbPeriod}, ${panda.bbStdDev}σ) upper penetration`,
    `MACD(${panda.macdFast},${panda.macdSlow},${panda.macdSignal}) histogram > 0${panda.requireMacdShift ? " (fresh shift only)" : ""}`,
    `confluence=${panda.confluenceMode}, confirmTicks=${panda.confirmTicks}`,
  ].join(" | ");
}

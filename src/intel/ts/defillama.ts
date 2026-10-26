/**
 * DeFiLlama price client for tokens on Robinhood Chain (chain id 4663).
 *
 * Endpoints used:
 *   GET /prices/current/robinhood:<token>   -> price, confidence, decimals, symbol
 *   GET /percentage/robinhood:<token>       -> 24h percentage change
 *   GET /chart/robinhood:<token>?span=24    -> fallback source for 24h change
 *
 * Every network/format problem is returned as data (`found: false` plus an
 * `error` string) instead of throwing. That matters for fresh Robinhood Chain
 * launches such as ASSAY, which DeFiLlama does not index yet.
 */

export const ROBINHOOD_CHAIN_SLUG = "robinhood";
/** Named distinctly so the library barrel can also export rpcAnalyzer's chain id. */
export const ROBINHOOD_PRICE_CHAIN_ID = 4663;
export const DEFAULT_DEFILLAMA_BASE_URL = "https://coins.llama.fi";

export type Change24hSource = "percentage" | "chart" | null;

export interface DefiLlamaOptions {
  /** Override for tests or self-hosted proxies. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 10s. */
  timeoutMs?: number;
  /** Injectable fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface DefiLlamaPriceResult {
  source: "defillama";
  chain: typeof ROBINHOOD_CHAIN_SLUG;
  chainId: typeof ROBINHOOD_PRICE_CHAIN_ID;
  /** Lower-cased token address. */
  token: `0x${string}`;
  found: boolean;
  symbol: string | null;
  decimals: number | null;
  priceUsd: number | null;
  change24hPct: number | null;
  change24hSource: Change24hSource;
  /** DeFiLlama confidence in the price, between 0 and 1. */
  confidence: number | null;
  /** Unix seconds reported by DeFiLlama. */
  priceTimestamp: number | null;
  /** ISO-8601 timestamp derived from `priceTimestamp`. */
  updatedAt: string | null;
  error: string | null;
  warnings: string[];
}

interface LlamaCoin {
  price?: unknown;
  symbol?: unknown;
  decimals?: unknown;
  confidence?: unknown;
  timestamp?: unknown;
}

interface LlamaCurrentResponse {
  coins?: Record<string, LlamaCoin | undefined>;
}

interface LlamaPercentageResponse {
  coins?: Record<string, unknown>;
}

interface LlamaChartResponse {
  coins?: Record<string, { prices?: unknown } | undefined>;
}

interface LlamaChartPoint {
  timestamp: number;
  price: number;
}

class DefiLlamaHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DefiLlamaHttpError";
    this.status = status;
  }
}


function emptyResult(token: `0x${string}`): DefiLlamaPriceResult {
  return {
    source: "defillama",
    chain: ROBINHOOD_CHAIN_SLUG,
    chainId: ROBINHOOD_PRICE_CHAIN_ID,
    token,
    found: false,
    symbol: null,
    decimals: null,
    priceUsd: null,
    change24hPct: null,
    change24hSource: null,
    confidence: null,
    priceTimestamp: null,
    updatedAt: null,
    error: null,
    warnings: [],
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request timed out";
    return error.message;
  }
  return String(error);
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "user-agent": "robinhood-token-intel/0.1 (+https://defillama.com/docs/api)",
      },
      signal: controller.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      const snippet = text.trim().slice(0, 200);
      throw new DefiLlamaHttpError(
        response.status,
        `HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
      );
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("DeFiLlama returned a non-JSON response");
    }
  } finally {
    clearTimeout(timer);
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}


/**
 * DeFiLlama's `/percentage` endpoint is the cheapest source for 24h change.
 * If it is unavailable, derive the change from the 24h chart history.
 */
async function fetch24hChange(
  coinKey: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ value: number | null; source: Change24hSource; warnings: string[] }> {
  const warnings: string[] = [];

  try {
    const payload = (await fetchJson(
      `${baseUrl}/percentage/${coinKey}`,
      fetchImpl,
      timeoutMs,
    )) as LlamaPercentageResponse;
    const raw = finiteNumber(payload?.coins?.[coinKey]);
    if (raw !== null) {
      return { value: raw, source: "percentage", warnings };
    }
  } catch (error) {
    warnings.push(
      `DeFiLlama 24h percentage endpoint failed (${describeError(error)}); trying chart history.`,
    );
  }

  try {
    const payload = (await fetchJson(
      `${baseUrl}/chart/${coinKey}?span=24&period=1h`,
      fetchImpl,
      timeoutMs,
    )) as LlamaChartResponse;
    const rawPrices = payload?.coins?.[coinKey]?.prices;

    if (Array.isArray(rawPrices)) {
      const points: LlamaChartPoint[] = [];
      for (const point of rawPrices) {
        if (!point || typeof point !== "object") continue;
        const { timestamp, price } = point as Record<string, unknown>;
        if (
          typeof timestamp === "number" &&
          Number.isFinite(timestamp) &&
          typeof price === "number" &&
          Number.isFinite(price) &&
          price > 0
        ) {
          points.push({ timestamp, price });
        }
      }

      if (points.length >= 2) {
        const first = points[0]!;
        const last = points[points.length - 1]!;
        const value = ((last.price - first.price) / first.price) * 100;
        const windowSeconds = last.timestamp - first.timestamp;

        if (Number.isFinite(value)) {
          if (windowSeconds < 12 * 60 * 60) {
            warnings.push(
              "DeFiLlama chart history spans less than 12 hours; the 24h change is approximate.",
            );
          }
          return { value, source: "chart", warnings };
        }
      }
    }

    warnings.push("DeFiLlama did not return usable 24h chart history for this token.");
  } catch (error) {
    warnings.push(`DeFiLlama 24h chart fallback failed: ${describeError(error)}`);
  }

  return { value: null, source: null, warnings };
}


/**
 * Fetch price, 24h change and confidence for a Robinhood Chain ERC-20 token.
 *
 * Never throws for network/indexing problems: inspect `found`, `error` and
 * `warnings` on the returned object.
 */
export async function fetchDefiLlamaPrice(
  tokenAddress: string,
  options: DefiLlamaOptions = {},
): Promise<DefiLlamaPriceResult> {
  const token = tokenAddress.toLowerCase() as `0x${string}`;
  const baseUrl = (options.baseUrl ?? DEFAULT_DEFILLAMA_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const coinKey = `${ROBINHOOD_CHAIN_SLUG}:${token}`;
  const result = emptyResult(token);

  let payload: LlamaCurrentResponse;
  try {
    payload = (await fetchJson(
      `${baseUrl}/prices/current/${coinKey}`,
      fetchImpl,
      timeoutMs,
    )) as LlamaCurrentResponse;
  } catch (error) {
    return {
      ...result,
      error: `DeFiLlama price request failed: ${describeError(error)}`,
    };
  }

  const coin = payload?.coins?.[coinKey];
  if (!coin) {
    return {
      ...result,
      error: `Token is not indexed by DeFiLlama yet (${coinKey}).`,
    };
  }

  const symbol = typeof coin.symbol === "string" && coin.symbol.trim() ? coin.symbol.trim() : null;
  const decimals = finiteNumber(coin.decimals);
  const confidence = finiteNumber(coin.confidence);
  const timestamp = finiteNumber(coin.timestamp);
  const price = finiteNumber(coin.price);
  const normalizedDecimals =
    decimals !== null && Number.isInteger(decimals) ? decimals : null;

  if (price === null || price <= 0) {
    return {
      ...result,
      found: true,
      symbol,
      decimals: normalizedDecimals,
      confidence,
      priceTimestamp: timestamp,
      updatedAt: timestamp !== null ? new Date(timestamp * 1000).toISOString() : null,
      error: "DeFiLlama has an entry for this token but no usable USD price.",
    };
  }

  const change = await fetch24hChange(coinKey, baseUrl, fetchImpl, timeoutMs);

  return {
    ...result,
    found: true,
    symbol,
    decimals: normalizedDecimals,
    priceUsd: price,
    change24hPct: change.value,
    change24hSource: change.source,
    confidence,
    priceTimestamp: timestamp,
    updatedAt: timestamp !== null ? new Date(timestamp * 1000).toISOString() : null,
    warnings: change.warnings,
  };
}

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
export declare const ROBINHOOD_CHAIN_SLUG = "robinhood";
/** Named distinctly so the library barrel can also export rpcAnalyzer's chain id. */
export declare const ROBINHOOD_PRICE_CHAIN_ID = 4663;
export declare const DEFAULT_DEFILLAMA_BASE_URL = "https://coins.llama.fi";
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
/**
 * Fetch price, 24h change and confidence for a Robinhood Chain ERC-20 token.
 *
 * Never throws for network/indexing problems: inspect `found`, `error` and
 * `warnings` on the returned object.
 */
export declare function fetchDefiLlamaPrice(tokenAddress: string, options?: DefiLlamaOptions): Promise<DefiLlamaPriceResult>;

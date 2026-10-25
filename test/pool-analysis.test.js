import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzePoolAddress,
  buildNarrative,
  formatPoolAnalysis,
  isEvmAddress,
} from "../tools/pool-analysis.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const POOL_BASE = "0x2222222222222222222222222222222222222222";
const POOL_POLYGON = "0x3333333333333333333333333333333333333333";

function response(payload) {
  return { ok: true, json: async () => payload };
}

function dexPair(overrides = {}) {
  return {
    chainId: "base",
    dexId: "uniswap",
    url: "https://dexscreener.com/base/0x2222",
    pairAddress: POOL_BASE,
    labels: ["v3"],
    baseToken: { address: TOKEN, name: "Morpheus", symbol: "MORPH" },
    quoteToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
    priceUsd: "0.42",
    txns: { h24: { buys: 800, sells: 400 } },
    volume: { h24: 1_000_000 },
    priceChange: { h24: 12.5 },
    liquidity: { usd: 500_000 },
    fdv: 50_000_000,
    marketCap: 40_000_000,
    pairCreatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function goPlusPayload() {
  return {
    result: {
      [TOKEN.toLowerCase()]: {
        holder_count: "10000",
        creator_percent: "0.01",
        is_honeypot: "0",
        buy_tax: "0",
        sell_tax: "0.05",
        is_mintable: "0",
        is_proxy: "0",
        is_open_source: "1",
        hidden_owner: "0",
        can_take_back_ownership: "0",
        owner_change_balance: "0",
        holders: [
          { address: "0xaaaa", percent: "0.25", is_contract: "0" },
          { address: "0xbbbb", percent: "0.10", is_contract: "1" },
          { address: "0xcccc", percent: "0.05", is_contract: "0" },
        ],
      },
    },
  };
}

test("validates EVM addresses", () => {
  assert.equal(isEvmAddress(TOKEN), true);
  assert.equal(isEvmAddress("0x123"), false);
  assert.equal(isEvmAddress("not-an-address"), false);
});

test("analyzes a token across multiple chains with pools, metrics and safety", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("dexscreener") && url.includes("/tokens/")) {
      return response({
        pairs: [
          dexPair(),
          dexPair({
            chainId: "polygon",
            dexId: "uniswap",
            pairAddress: POOL_POLYGON,
            url: "https://dexscreener.com/polygon/0x3333",
            liquidity: { usd: 100_000 },
            volume: { h24: 50_000 },
          }),
        ],
      });
    }
    if (url.includes("goplus")) return response(goPlusPayload());
    return response({ pairs: [] });
  };
  const router = {
    get: () => ({
      getPoolState: async (pool) => ({ fee: pool === POOL_BASE ? 500 : 3000 }),
    }),
  };
  const config = {
    rpcByChain: { base: ["https://base.example"], polygon: ["https://polygon.example"] },
  };

  const analysis = await analyzePoolAddress({
    address: TOKEN,
    config,
    router,
    fetchImpl,
    enableRpcFallback: true,
  });

  assert.equal(analysis.chain, "base");
  assert.equal(analysis.token.symbol, "MORPH");
  assert.equal(analysis.pools.length, 2);
  assert.equal(analysis.primary.feePercent, 0.05);
  assert.equal(analysis.primary.tvl, 500_000);
  assert.equal(analysis.primary.volume24h, 1_000_000);
  assert.equal(analysis.holders.holderCount, 10_000);
  assert.equal(analysis.holders.top10Pct, 40);
  assert.equal(analysis.narrative.volumeTvlPct, 200);
  assert.match(analysis.narrative.volumeHealth, /High Vol\/TVL/);
  assert.equal(analysis.narrative.riskStatus, "MEDIUM");

  const text = formatPoolAnalysis(analysis);
  assert.match(text, /<b>MORPH\/USDC<\/b>/);
  assert.match(text, /fee 0\.05%/);
  assert.match(text, /Vol\/TVL 200\.0%/);
  assert.match(text, /Top10: 40\.0%/);
  assert.match(text, /<a href="https:\/\/dexscreener\.com\/base\/0x2222">Chart<\/a>/);
  assert.match(text, /Risk: <b>MEDIUM<\/b>/);
  assert.match(text, /2 found/);
});

test("resolves a pool address through GeckoTerminal fallback", async () => {
  const poolAddress = "0x4444444444444444444444444444444444444444";
  const geckoPool = {
    id: `polygon_pos_${poolAddress}`,
    type: "pool",
    attributes: {
      address: poolAddress,
      name: "USDC / WETH 0.01%",
      base_token_price_usd: "1.0001",
      quote_token_price_usd: "2350",
      reserve_in_usd: "250000",
      volume_usd: { h24: "750000" },
      price_change_percentage: { h24: "-1.2" },
      market_cap_usd: "100000000",
      fdv_usd: "120000000",
      transactions: { h24: { buys: 2000, sells: 1800 } },
      pool_created_at: "2025-01-01T00:00:00Z",
    },
    relationships: {
      base_token: { data: { id: `polygon_pos_${USDC}` } },
      quote_token: { data: { id: `polygon_pos_${WETH}` } },
      dex: { data: { id: "uniswap_v3" } },
    },
  };
  const fetchImpl = async (url) => {
    if (url.includes("dexscreener")) return response({ pairs: [] });
    if (url.includes("geckoterminal") && url.includes("search/pools")) {
      return response({ data: [geckoPool] });
    }
    if (url.includes("goplus")) return response({ result: {} });
    return response({ data: [] });
  };

  const analysis = await analyzePoolAddress({
    address: poolAddress,
    fetchImpl,
    enableRpcFallback: false,
  });

  assert.equal(analysis.chain, "polygon");
  assert.equal(analysis.pools.length, 1);
  assert.equal(analysis.primary.feePercent, 0.01);
  assert.equal(analysis.token.symbol, "WETH");
  assert.equal(analysis.priceUsd, 2350);
  assert.equal(analysis.narrative.volumeTvlPct, 300);
  const text = formatPoolAnalysis(analysis);
  assert.match(text, /USDC\/WETH/);
  assert.match(text, /geckoterminal\.com\/polygon_pos\/pools/);
  assert.match(text, /Narrative/);
});

test("renders helpful errors for invalid or unknown addresses", async () => {
  const invalid = await analyzePoolAddress({ address: "0x123", enableRpcFallback: false });
  assert.match(formatPoolAnalysis(invalid), /Invalid EVM contract address/);

  const fetchImpl = async (url) => {
    if (url.includes("dexscreener")) return response({ pairs: [] });
    if (url.includes("geckoterminal")) return response({ data: [] });
    return response({ data: [] });
  };
  const unknown = await analyzePoolAddress({
    address: "0x5555555555555555555555555555555555555555",
    fetchImpl,
    enableRpcFallback: false,
  });
  assert.match(unknown.error, /No supported EVM chain/);
  assert.match(formatPoolAnalysis(unknown), /No supported EVM chain/);

  const noPools = await analyzePoolAddress({
    address: "0x6666666666666666666666666666666666666666",
    fetchImpl,
    enableRpcFallback: false,
  });
  assert.match(formatPoolAnalysis(noPools), /No supported EVM chain/);
});

test("narrative flags honeypots and thin liquidity as high risk", () => {
  const narrative = buildNarrative(
    { tvl: 10_000, volume24h: 1_000, fdv: 10_000_000, buys: 10, sells: 90, txns24h: 100 },
    {
      top10Pct: 85,
      creatorPct: 10,
      flags: { honeypot: true, buyTax: 20, sellTax: 20, mintable: true },
    },
  );
  assert.equal(narrative.riskStatus, "HIGH");
  assert.match(narrative.reasons.join(" "), /honeypot/i);
  assert.match(narrative.reasons.join(" "), /Top 10/);
  assert.match(narrative.activityNote, /sell-side dominant/);
});


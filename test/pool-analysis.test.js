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

function goPlusPayload(tokenAddress = TOKEN) {
  return {
    result: {
      [tokenAddress.toLowerCase()]: {
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
  const goplusRequests = [];
  const fetchImpl = async (url) => {
    if (url.includes("dexscreener")) return response({ pairs: [] });
    if (url.includes("geckoterminal") && url.includes("search/pools")) {
      return response({ data: [geckoPool] });
    }
    if (url.includes("goplus")) {
      goplusRequests.push(url);
      return response({ result: {} });
    }
    return response({ data: [] });
  };

  const analysis = await analyzePoolAddress({
    address: poolAddress,
    fetchImpl,
    enableRpcFallback: false,
  });

  assert.equal(analysis.chain, "polygon");
  assert.equal(analysis.addressType, "pool");
  assert.equal(analysis.pools.length, 1);
  assert.equal(analysis.pools[0].pool, poolAddress);
  assert.equal(analysis.poolTokens.length, 2);
  assert.equal(analysis.tokenSecurities.length, 2);
  assert.equal(analysis.securityVerified, false);
  assert.equal(goplusRequests.length, 2);
  assert.ok(goplusRequests.some((url) => url.toLowerCase().includes(USDC.toLowerCase())));
  assert.ok(goplusRequests.some((url) => url.toLowerCase().includes(WETH.toLowerCase())));
  assert.equal(analysis.primary.feePercent, 0.01);
  assert.equal(analysis.token.symbol, "WETH");
  assert.equal(analysis.priceUsd, 2350);
  assert.equal(analysis.narrative.volumeTvlPct, 300);
  const text = formatPoolAnalysis(analysis);
  assert.match(text, /Type: <b>POOL<\/b>/);
  assert.match(text, /USDC\/WETH/);
  assert.match(text, /geckoterminal\.com\/polygon_pos\/pools/);
  assert.match(text, /Pool token checks:/);
  assert.match(text, /Risk: <b>UNVERIFIED \(MEDIUM\)<\/b>/);
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

test("resolves a token address to every pool where it is token0 or token1", async () => {
  const token = "0x7777777777777777777777777777777777777777";
  const other = "0x8888888888888888888888888888888888888888";
  const poolA = "0xaaaa000000000000000000000000000000000001";
  const poolB = "0xbbbb000000000000000000000000000000000002";
  const decoy = "0xcccc000000000000000000000000000000000003";
  const goplusRequests = [];

  const fetchImpl = async (url) => {
    if (url.includes("dexscreener") && url.includes("/tokens/")) {
      return response({
        pairs: [
          dexPair({
            pairAddress: poolA,
            baseToken: { address: token, name: "Morpheus", symbol: "MORPH" },
            quoteToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
          }),
          dexPair({
            pairAddress: poolB,
            baseToken: { address: WETH, name: "Wrapped Ether", symbol: "WETH" },
            quoteToken: { address: token, name: "Morpheus", symbol: "MORPH" },
          }),
          dexPair({
            pairAddress: decoy,
            baseToken: { address: other, name: "Other", symbol: "OTH" },
            quoteToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
          }),
        ],
      });
    }
    if (url.includes("goplus")) {
      goplusRequests.push(url);
      return response(goPlusPayload(token));
    }
    return response({ pairs: [] });
  };

  const analysis = await analyzePoolAddress({
    address: token,
    fetchImpl,
    enableRpcFallback: false,
  });

  assert.equal(analysis.addressType, "token");
  assert.equal(analysis.address, token);
  assert.equal(analysis.pools.length, 2, "decoy pool must be filtered out");
  for (const pool of analysis.pools) {
    assert.equal(isEvmAddress(pool.pool), true, `pool address ${pool.pool}`);
    assert.equal(pool.token0.length, 42);
    assert.equal(pool.token1.length, 42);
    assert.ok(
      [pool.token0, pool.token1].some((address) => address.toLowerCase() === token),
      "resolved pool must contain the token as token0 or token1",
    );
  }
  assert.ok(
    analysis.pools.some((pool) => pool.pool === poolA)
      && analysis.pools.some((pool) => pool.pool === poolB),
    "both base and quote side pools must resolve",
  );

  // GoPlus must be queried with the TOKEN address, never a pool address.
  assert.equal(goplusRequests.length, 1);
  assert.match(goplusRequests[0], new RegExp(token.toLowerCase()));
  assert.ok(!goplusRequests[0].toLowerCase().includes(poolA.slice(2, 10)));

  const text = formatPoolAnalysis(analysis);
  assert.match(text, /Type: <b>TOKEN<\/b>/);
  assert.match(text, /2 found/);
});

test("normalizes bytes32 pool ids, parses fee tiers and shows only top 3 pools", async () => {
  const token = "0x9999999999999999999999999999999999999999";
  const addresses = [
    "0x1000000000000000000000000000000000000001",
    "0x2000000000000000000000000000000000000002",
    "0x3000000000000000000000000000000000000003",
    "0x4000000000000000000000000000000000000004",
  ];
  const fetchImpl = async (url) => {
    if (url.includes("dexscreener") && url.includes("/tokens/")) {
      return response({
        pairs: addresses.map((address, index) => dexPair({
          // First pool id is a left-padded ABI word (topic style).
          pairAddress: index === 0 ? `0x${"0".repeat(24)}${address.slice(2)}` : address,
          feeTier: [100, 500, 3000, 10000][index],
          liquidity: { usd: 1_000_000 - index * 100_000 },
          baseToken: { address: token, name: "Morpheus", symbol: "MORPH" },
        })),
      });
    }
    if (url.includes("goplus")) return response({ result: {} });
    return response({ pairs: [] });
  };

  const analysis = await analyzePoolAddress({
    address: token,
    fetchImpl,
    enableRpcFallback: false,
  });

  assert.deepEqual(
    analysis.pools.map((pool) => pool.feePercent),
    [0.01, 0.05, 0.3, 1],
  );
  assert.equal(analysis.pools[0].pool, addresses[0]);
  assert.ok(analysis.pools.every((pool) => isEvmAddress(pool.pool)));

  const text = formatPoolAnalysis(analysis);
  assert.match(text, /fee 0\.01%/);
  assert.match(text, /…\+1 minor pools/);
  assert.match(text, /Risk: <b>UNVERIFIED \(MEDIUM\)<\/b>/);
  assert.match(text, /⚠️ Token safety metadata unverified/);
  for (const match of text.matchAll(/<code>(0x[0-9a-fA-F]+)<\/code>/g)) {
    if (match[1].length === 42) continue;
    // Short values are allowed only for holder abbreviations in this report.
    assert.equal(match[1].startsWith("0x") && match[1].length < 42, true);
  }
  assert.ok(!/<code>0x[0-9a-fA-F]{42,}<\/code>/.test(text));
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


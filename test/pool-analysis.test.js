import test from "node:test";
import assert from "node:assert/strict";

import {
  UNISWAP_FEE_TIERS,
  analyzePoolAddress,
  buildNarrative,
  feeTierLabel,
  fetchIndexerPool,
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
  const publicClient = {
    readContract: async ({ address }) => (
      String(address).toLowerCase() === POOL_BASE.toLowerCase() ? 500 : 3000
    ),
  };

  const analysis = await analyzePoolAddress({
    address: TOKEN,
    config,
    router,
    publicClient,
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


test("maps raw Uniswap v3 fee tiers to canonical percentage labels", () => {
  assert.deepEqual(UNISWAP_FEE_TIERS, {
    100: "0.01%",
    500: "0.05%",
    3000: "0.3%",
    10000: "1.0%",
  });
  assert.equal(feeTierLabel(100), "0.01%");
  assert.equal(feeTierLabel(500), "0.05%");
  assert.equal(feeTierLabel(3000), "0.3%");
  assert.equal(feeTierLabel(10000), "1.0%");
  assert.equal(feeTierLabel("500"), "0.05%");
  assert.equal(feeTierLabel("0.05%"), "0.05%");
  assert.equal(feeTierLabel(0.0005), "0.05%");
  assert.equal(feeTierLabel(0.25), "0.25%");
  assert.equal(feeTierLabel(null), null);
  assert.equal(feeTierLabel("n/a"), null);
});

test("resolves a missing fee tier from a subgraph Pool entity", async () => {
  const pool = "0xd1d2d3d4d5d6d7d8d9daDbDcDdDeDfD0D1D2D3D4";
  const season = "0xa1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4";
  const weth = "0xb1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4";
  const indexerUrl = "https://indexer.example/graphql";
  let indexerCalls = 0;

  const fetchImpl = async (url, options = {}) => {
    if (url.includes("dexscreener") && url.includes("/tokens/")) {
      return response({
        pairs: [dexPair({
          chainId: "robinhood",
          pairAddress: pool,
          url: "https://dexscreener.com/robinhood/0xd1d2",
          feeTier: null,
          fee: null,
          baseToken: { address: season, name: "Season", symbol: "SEASON" },
          quoteToken: { address: weth, name: "Wrapped Ether", symbol: "WETH" },
        })],
      });
    }
    if (url === indexerUrl && options.method === "POST") {
      indexerCalls += 1;
      const body = JSON.parse(options.body);
      assert.match(body.query, /pool\(id: \$id\)/);
      if (body.variables.id !== pool.toLowerCase()) {
        return response({ data: { pool: null } });
      }
      return response({
        data: {
          pool: {
            id: pool.toLowerCase(),
            feeTier: "500",
            tickSpacing: "10",
            token0: { id: season.toLowerCase(), symbol: "SEASON" },
            token1: { id: weth.toLowerCase(), symbol: "WETH" },
          },
        },
      });
    }
    if (url.includes("goplus")) return response({ result: {} });
    return response({ pairs: [] });
  };

  const analysis = await analyzePoolAddress({
    address: pool,
    config: {
      indexer: { url: indexerUrl, type: "subgraph" },
    },
    fetchImpl,
    enableRpcFallback: false,
  });

  assert.equal(analysis.addressType, "pool");
  assert.equal(analysis.chain, "robinhood");
  assert.equal(analysis.primary.feePercent, 0.05);
  assert.equal(analysis.primary.feeTier, 500);
  assert.equal(analysis.primary.tickSpacing, 10);
  assert.equal(analysis.primary.feeSource, "subgraph");
  assert.ok(indexerCalls >= 1);

  const text = formatPoolAnalysis(analysis);
  assert.match(text, /SEASON\/WETH<\/b> — Uniswap v3 \(0\.05%\)/);
  assert.match(text, /fee 0\.05%/);
  assert.match(text, /tick 10/);
});

test("queries a Defined.fi style REST indexer for pool metadata", async () => {
  const pool = "0xe1e2e3e4e5e6e7e8e9eaebecedeeef0011223344";
  const tokenA = "0x1111111111111111111111111111111111111111";
  const tokenB = "0x2222222222222222222222222222222222222222";
  const requests = [];

  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return response({
      data: {
        pool: {
          id: pool,
          fee: "0.3%",
          tickSpacing: 60,
          token0: { id: tokenA, symbol: "AAA" },
          token1: { id: tokenB, symbol: "BBB" },
        },
      },
    });
  };

  const indexed = await fetchIndexerPool(pool, {
    chainKey: "base",
    config: {
      indexer: { url: "https://api.defined.fi/v1", type: "defined" },
    },
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "GET");
  assert.match(requests[0].url, /\/pools\/0xe1e2/i);
  assert.equal(indexed.source, "defined");
  assert.equal(indexed.feePercent, 0.3);
  assert.equal(indexed.feeTier, 3000);
  assert.equal(indexed.tickSpacing, 60);
  assert.equal(indexed.pair, "AAA/BBB");
});


test("auto-detects an Envio GraphQL endpoint and reads tickSpacing", async () => {
  const pool = "0xf1f2f3f4f5f6f7f8f9fafbfcfdfeff0011223344";
  const tokenA = "0x3333333333333333333333333333333333333333";
  const tokenB = "0x4444444444444444444444444444444444444444";

  const indexed = await fetchIndexerPool(pool, {
    chainKey: "robinhood",
    config: {
      indexer: { url: "https://envio.example/v1/graphql", type: "auto" },
    },
    fetchImpl: async (url, options = {}) => {
      assert.equal(options.method, "POST");
      return response({
        data: {
          pool: {
            id: pool.toLowerCase(),
            feeTier: 10000,
            tickSpacing: 200,
            token0: { id: tokenA, symbol: "AAA" },
            token1: { id: tokenB, symbol: "BBB" },
          },
        },
      });
    },
  });

  assert.equal(indexed.source, "envio");
  assert.equal(indexed.chain, "robinhood");
  assert.equal(indexed.feePercent, 1);
  assert.equal(indexed.feeTier, 10000);
  assert.equal(indexed.tickSpacing, 200);
  assert.equal(feeTierLabel(indexed.feePercent), "1.0%");
});

test("fee pipeline prefers the indexer over the on-chain fee() RPC", async () => {
  const pool = "0x5555555555555555555555555555555555555555";
  const token = "0x6666666666666666666666666666666666666666";
  const quote = "0x7777777777777777777777777777777777777777";
  const indexerUrl = "https://indexer.example/graphql";
  const rpcCalls = [];

  const fetchImpl = async (url, options = {}) => {
    if (url.includes("dexscreener") && url.includes("/tokens/")) {
      return response({
        pairs: [dexPair({
          pairAddress: pool,
          feeTier: null,
          fee: null,
          baseToken: { address: token, name: "Morpheus", symbol: "MORPH" },
          quoteToken: { address: quote, name: "USD Coin", symbol: "USDC" },
        })],
      });
    }
    if (url === indexerUrl && options.method === "POST") {
      return response({
        data: {
          pool: {
            id: pool.toLowerCase(),
            feeTier: 3000,
            tickSpacing: 60,
            token0: { id: token, symbol: "MORPH" },
            token1: { id: quote, symbol: "USDC" },
          },
        },
      });
    }
    if (url.includes("goplus")) return response({ result: {} });
    return response({ pairs: [] });
  };
  const router = {
    get: () => ({
      getPoolState: async () => {
        rpcCalls.push("getPoolState");
        return { fee: 100 };
      },
    }),
  };

  const analysis = await analyzePoolAddress({
    address: token,
    config: {
      rpcByChain: { base: ["https://base.example"] },
      indexer: { url: indexerUrl, type: "subgraph" },
    },
    router,
    fetchImpl,
    enableRpcFallback: true,
  });

  assert.equal(analysis.primary.feePercent, 0.3);
  assert.equal(analysis.primary.feeTier, 3000);
  assert.equal(analysis.primary.tickSpacing, 60);
  assert.equal(analysis.primary.feeSource, "subgraph");
  assert.equal(rpcCalls.length, 0, "indexer result must short-circuit the RPC fallback");
});

test("token screening fills feeTier from the subgraph when DexScreener only returns a percentage", async () => {
  const pool = "0xabababababababababababababababababababab";
  const token = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
  const quote = "0xefefefefefefefefefefefefefefefefefefefef";
  const indexerUrl = "https://indexer.example/graphql";
  const rpcCalls = [];

  const fetchImpl = async (url, options = {}) => {
    if (url.includes("dexscreener") && url.includes("/tokens/")) {
      return response({
        pairs: [dexPair({
          chainId: "robinhood",
          pairAddress: pool,
          feeTier: null,
          fee: "0.3%",
          baseToken: { address: token, name: "Season", symbol: "SEASON" },
          quoteToken: { address: quote, name: "Wrapped Ether", symbol: "WETH" },
        })],
      });
    }
    if (url === indexerUrl && options.method === "POST") {
      return response({
        data: {
          pool: {
            id: pool.toLowerCase(),
            feeTier: 3000,
            tickSpacing: 60,
            token0: { id: token, symbol: "SEASON" },
            token1: { id: quote, symbol: "WETH" },
          },
        },
      });
    }
    if (url.includes("goplus")) return response({ result: {} });
    return response({ pairs: [] });
  };
  const router = {
    get: () => ({
      getPoolState: async () => {
        rpcCalls.push("getPoolState");
        return { fee: 3000, tickSpacing: 60 };
      },
    }),
  };

  const analysis = await analyzePoolAddress({
    address: token,
    config: {
      rpcByChain: { robinhood: ["https://robinhood.example"] },
      indexer: { url: indexerUrl, type: "subgraph" },
    },
    router,
    fetchImpl,
    enableRpcFallback: true,
  });

  assert.equal(analysis.addressType, "token");
  assert.equal(analysis.primary.feePercent, 0.3);
  assert.equal(analysis.primary.feeTier, 3000);
  assert.equal(analysis.primary.tickSpacing, 60);
  assert.equal(analysis.primary.feeSource, "dexscreener");
  assert.equal(rpcCalls.length, 0, "subgraph feeTier must short-circuit the RPC fallback");
  assert.match(formatPoolAnalysis(analysis), /fee 0\.3%/);
});

test("formats fee from feePercent, feeTier or fee without rendering n/a", () => {
  const poolBase = {
    chain: "robinhood",
    pair: "SEASON/WETH",
    dex: "Uniswap v3",
    dexId: "uniswap",
    tvl: 100_000,
    volume24h: 10_000,
    tickSpacing: 60,
  };
  const text = formatPoolAnalysis({
    address: "0x1234567890abcdef1234567890abcdef12345678",
    addressType: "token",
    chainName: "Robinhood Chain",
    chainId: 4663,
    token: {
      address: "0x1234567890abcdef1234567890abcdef12345678",
      symbol: "SEASON",
      name: "Season",
    },
    pools: [
      {
        ...poolBase,
        pool: "0x1111111111111111111111111111111111111111",
        feeTier: 500,
      },
      {
        ...poolBase,
        pool: "0x2222222222222222222222222222222222222222",
        fee: 10_000,
      },
      {
        ...poolBase,
        pool: "0x3333333333333333333333333333333333333333",
        feePercent: 0.3,
      },
    ],
  });

  assert.match(text, /SEASON\/WETH<\/b> — Uniswap v3 \(0\.05%\)/);
  assert.match(text, /fee 0\.05%/);
  assert.match(text, /Uniswap v3 \(1\.0%\)/);
  assert.match(text, /fee 1\.0%/);
  assert.match(text, /Uniswap v3 \(0\.3%\)/);
  assert.match(text, /fee 0\.3%/);
  assert.doesNotMatch(text, /fee n\/a/);
});

test("resolves a direct Robinhood pool address from the subgraph when aggregators return nothing", async () => {
  const pool = "0xaaaaaaaabbbbbbbbccccccccddddddddeeeeeeee";
  const token0 = "0x1234567890abcdef1234567890abcdef12345678";
  const token1 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const indexerUrl = "https://subgraph.example/graphql";
  let indexerCalls = 0;

  const fetchImpl = async (url, options = {}) => {
    if (url === indexerUrl && options.method === "POST") {
      indexerCalls += 1;
      return response({
        data: {
          pool: {
            id: pool.toLowerCase(),
            feeTier: 500,
            tickSpacing: 10,
            token0: { id: token0, symbol: "SEASON" },
            token1: { id: token1, symbol: "WETH" },
          },
        },
      });
    }
    if (url.includes("goplus")) return response({ result: {} });
    if (url.includes("geckoterminal")) return response({ data: [] });
    return response({ pairs: [] });
  };

  const analysis = await analyzePoolAddress({
    address: pool,
    config: {
      chain: "robinhood",
      indexer: { url: indexerUrl, type: "subgraph", byChain: { robinhood: indexerUrl } },
    },
    fetchImpl,
    enableRpcFallback: false,
  });

  assert.equal(analysis.error, undefined);
  assert.equal(analysis.addressType, "pool");
  assert.equal(analysis.chain, "robinhood");
  assert.equal(analysis.primary.pool, pool);
  assert.equal(analysis.primary.feeTier, 500);
  assert.equal(analysis.primary.feePercent, 0.05);
  assert.equal(analysis.primary.tickSpacing, 10);
  assert.ok(indexerCalls >= 1);
  assert.match(formatPoolAnalysis(analysis), /fee 0\.05%/);
});

test("classifies and displays a Robinhood pool from getPoolState when aggregators return nothing", async () => {
  const pool = "0xffeba86d3912b6084212ab6080a390822af00949";
  const token0 = "0x1111111111111111111111111111111111111111";
  const token1 = "0x2222222222222222222222222222222222222222";
  const chainKeys = [
    "ethereum", "bnb", "base", "arbitrum", "polygon", "avalanche", "optimism", "robinhood",
  ];
  const rpcByChain = Object.fromEntries(
    chainKeys.map((key) => [key, [`https://${key}.example`]]),
  );
  const state = {
    pool,
    token0,
    token1,
    token0Symbol: "SEASON",
    token1Symbol: "WETH",
    decimals0: 18,
    decimals1: 18,
    fee: 3000,
    tickSpacing: 60,
    price: 1.5,
    liquidity: "123456789",
    sqrtPriceX96: "1",
    tick: 0,
  };
  const clients = Object.fromEntries(chainKeys.map((key) => [
    key,
    {
      provider: {
        getCode: async () => "0x",
        call: async () => "0x",
      },
      getPoolState: async (address) => {
        if (key !== "robinhood" || String(address).toLowerCase() !== pool) {
          throw new Error(`not a pool on ${key}`);
        }
        return state;
      },
    },
  ]));
  const fetchImpl = async (url) => {
    if (url.includes("goplus")) return response({ result: {} });
    if (url.includes("geckoterminal")) return response({ data: [] });
    return response({ pairs: [] });
  };

  const analysis = await analyzePoolAddress({
    address: pool,
    config: {
      chain: "robinhood",
      rpcByChain,
      indexer: { enabled: false },
    },
    router: { get: (key) => clients[key] || null },
    fetchImpl,
    timeoutMs: 1_000,
    enableRpcFallback: true,
  });

  assert.equal(analysis.error, undefined);
  assert.equal(analysis.addressType, "pool");
  assert.equal(analysis.chain, "robinhood");
  assert.equal(analysis.chainId, 4663);
  assert.equal(analysis.primary.pool, pool);
  assert.equal(analysis.primary.feeTier, 3000);
  assert.equal(analysis.primary.feePercent, 0.3);
  assert.equal(analysis.primary.tickSpacing, 60);
  assert.equal(analysis.primary.priceNative, 1.5);
  assert.equal(analysis.primary.liquidity, "123456789");

  const text = formatPoolAnalysis(analysis);
  assert.match(text, /Type: <b>POOL<\/b>/);
  assert.match(text, /fee 0\.3%/);
  assert.match(text, /tick 60/);
  assert.match(text, /On-chain liquidity 123456789/);
  assert.match(text, /price \$1\.5 WETH\/SEASON/);
});

test("token screening enriches every pool with feeTier and tickSpacing before formatting", async () => {
  const token = "0x3333333333333333333333333333333333333333";
  const quote = "0x4444444444444444444444444444444444444444";
  const poolA = "0x5555555555555555555555555555555555555555";
  const poolB = "0x6666666666666666666666666666666666666666";
  const readCalls = [];
  const fees = new Map([
    [poolA.toLowerCase(), { fee: 500, tickSpacing: 10 }],
    [poolB.toLowerCase(), { fee: 10000, tickSpacing: 200 }],
  ]);
  const publicClient = {
    readContract: async ({ address, abi, functionName }) => {
      const key = String(address).toLowerCase();
      readCalls.push(key);
      assert.equal(functionName, "fee");
      assert.equal(abi[0].outputs[0].type, "uint24");
      return fees.get(key)?.fee ?? null;
    },
  };

  const fetchImpl = async (url) => {
    if (url.includes("dexscreener") && url.includes("/tokens/")) {
      return response({
        pairs: [
          dexPair({
            pairAddress: poolA,
            feeTier: null,
            fee: null,
            liquidity: { usd: 900_000 },
            baseToken: { address: token, name: "Morpheus", symbol: "MORPH" },
            quoteToken: { address: quote, name: "USD Coin", symbol: "USDC" },
          }),
          dexPair({
            pairAddress: poolB,
            feeTier: null,
            fee: null,
            liquidity: { usd: 500_000 },
            baseToken: { address: token, name: "Morpheus", symbol: "MORPH" },
            quoteToken: { address: quote, name: "USD Coin", symbol: "USDC" },
          }),
        ],
      });
    }
    if (url.includes("goplus")) return response({ result: {} });
    return response({ pairs: [] });
  };
  const analysis = await analyzePoolAddress({
    address: token,
    config: {
      chain: "base",
      rpcByChain: { base: ["https://base.example"] },
      indexer: { enabled: false },
    },
    publicClient,
    fetchImpl,
    timeoutMs: 1_000,
    enableRpcFallback: true,
  });

  assert.equal(analysis.addressType, "token");
  assert.equal(analysis.pools.length, 2);
  const byPool = new Map(analysis.pools.map((entry) => [entry.pool.toLowerCase(), entry]));
  assert.equal(byPool.get(poolA.toLowerCase()).feeTier, 500);
  assert.equal(byPool.get(poolA.toLowerCase()).feePercent, 0.05);
  assert.equal(byPool.get(poolA.toLowerCase()).tickSpacing, 10);
  assert.equal(byPool.get(poolB.toLowerCase()).feeTier, 10000);
  assert.equal(byPool.get(poolB.toLowerCase()).feePercent, 1);
  assert.equal(byPool.get(poolB.toLowerCase()).tickSpacing, 200);
  assert.deepEqual(
    [...readCalls].sort(),
    [poolA.toLowerCase(), poolB.toLowerCase()].sort(),
  );

  const text = formatPoolAnalysis(analysis);
  assert.match(text, /fee 0\.05%/);
  assert.match(text, /fee 1\.0%/);
});

test("falls back to on-chain fee() when the indexer has no pool", async () => {
  const pool = "0x8888888888888888888888888888888888888888";
  const token = "0x9999999999999999999999999999999999999999";
  const quote = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const indexerUrl = "https://indexer.example/graphql";
  const readCalls = [];

  const fetchImpl = async (url, options = {}) => {
    if (url.includes("dexscreener") && url.includes("/tokens/")) {
      return response({
        pairs: [dexPair({
          pairAddress: pool,
          feeTier: null,
          fee: null,
          baseToken: { address: token, name: "Morpheus", symbol: "MORPH" },
          quoteToken: { address: quote, name: "USD Coin", symbol: "USDC" },
        })],
      });
    }
    if (url === indexerUrl && options.method === "POST") {
      return response({ data: { pool: null } });
    }
    if (url.includes("goplus")) return response({ result: {} });
    return response({ pairs: [] });
  };
  const publicClient = {
    readContract: async ({ address, functionName }) => {
      readCalls.push(String(address).toLowerCase());
      assert.equal(functionName, "fee");
      return 10000;
    },
  };

  const analysis = await analyzePoolAddress({
    address: token,
    config: {
      rpcByChain: { base: ["https://base.example"] },
      indexer: { url: indexerUrl, type: "graphql" },
    },
    publicClient,
    fetchImpl,
    enableRpcFallback: true,
  });

  assert.equal(analysis.primary.feePercent, 1);
  assert.equal(analysis.primary.feeTier, 10000);
  assert.equal(analysis.primary.fee, 10000);
  assert.equal(analysis.primary.tickSpacing, 200);
  assert.equal(analysis.primary.feeSource, "rpc");
  assert.deepEqual(readCalls, [pool.toLowerCase()]);
  assert.match(formatPoolAnalysis(analysis), /fee 1\.0%/);
});

test("token screening resolves missing fees for all top-10 pools via direct readContract", async () => {
  const token = "0x7777777777777777777777777777777777777777";
  const pools = Array.from(
    { length: 10 },
    (_, index) => `0x${String(index + 1).padStart(2, "0").repeat(20)}`,
  );
  const readCalls = [];
  const publicClient = {
    readContract: async ({ address, abi, functionName }) => {
      readCalls.push(String(address).toLowerCase());
      assert.equal(functionName, "fee");
      assert.equal(abi[0]?.name, "fee");
      assert.equal(abi[0]?.outputs?.[0]?.type, "uint24");
      return 3000;
    },
  };

  const fetchImpl = async (url) => {
    if (url.includes("dexscreener") && url.includes("/tokens/")) {
      return response({
        pairs: pools.map((pool, index) => dexPair({
          pairAddress: pool,
          // Aggregator omits both fee representations.
          feeTier: null,
          fee: null,
          liquidity: { usd: 1_000_000 - index * 10_000 },
          baseToken: { address: token, name: "Morph", symbol: "MORPH" },
          quoteToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
        })),
      });
    }
    if (url.includes("goplus")) return response({ result: {} });
    return response({ pairs: [] });
  };

  const analysis = await analyzePoolAddress({
    address: token,
    config: {
      chain: "base",
      rpcByChain: { base: ["https://base.example"] },
      indexer: { enabled: false },
    },
    publicClient,
    fetchImpl,
    timeoutMs: 1_000,
    enableRpcFallback: true,
  });

  assert.equal(analysis.addressType, "token");
  assert.equal(analysis.pools.length, 10);
  for (const pool of analysis.pools) {
    assert.equal(pool.feeTier, 3000);
    assert.equal(pool.feePercent, 0.3);
    assert.equal(pool.fee, 3000);
    assert.equal(pool.feeSource, "rpc");
    assert.equal(pool.tickSpacing, 60);
  }
  assert.deepEqual(
    [...readCalls].sort(),
    pools.map((pool) => pool.toLowerCase()).sort(),
  );

  const text = formatPoolAnalysis(analysis);
  assert.match(text, /fee 0\.3%/);
  assert.doesNotMatch(text, /fee n\/a/);
});


import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress } from "ethers";

import {
  CHAINS,
  chainInfo,
  chainRuntimeConfig,
  loadConfig,
} from "../config.js";

function withEnv(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("registry contains the five supported chains with the right IDs", () => {
  assert.equal(CHAINS.arbitrum.chainId, 42161);
  assert.equal(CHAINS.base.chainId, 8453);
  assert.equal(CHAINS.ethereum.chainId, 1);
  assert.equal(CHAINS.bnb.chainId, 56);
  assert.equal(CHAINS.robinhood.chainId, 4663);
});

test("chain aliases resolve to the canonical registry entries", () => {
  assert.equal(chainInfo("eth").key, "ethereum");
  assert.equal(chainInfo("mainnet").key, "ethereum");
  assert.equal(chainInfo("bsc").key, "bnb");
  assert.equal(chainInfo("binance").key, "bnb");
  assert.equal(chainInfo("orbit").key, "robinhood");
  assert.equal(chainInfo("robinhood-chain").key, "robinhood");
  assert.equal(chainInfo("arb").key, "arbitrum");
});

for (const [key, chain] of Object.entries(CHAINS)) {
  test(`${key} has valid Uniswap v3 addresses, RPC presets and tokens`, () => {
    assert.ok(ADDRESS(chain.factory), `${key} factory`);
    assert.ok(ADDRESS(chain.positionManager), `${key} positionManager`);
    assert.ok(ADDRESS(chain.quoterV2), `${key} quoterV2`);
    assert.ok(Array.isArray(chain.rpcUrls) && chain.rpcUrls.length >= 1, `${key} rpcUrls`);
    assert.equal(chain.rpcUrl, chain.rpcUrls[0], `${key} primary RPC matches preset[0]`);
    for (const url of chain.rpcUrls) assert.match(url, /^https:\/\//);
    assert.ok(chain.geckoNetwork, `${key} geckoNetwork`);
    assert.ok(chain.dexscreenerChain, `${key} dexscreenerChain`);
    assert.ok(chain.wrappedNative, `${key} wrappedNative`);
    assert.ok(chain.tokens[chain.wrappedNative], `${key} wrapped native token`);
    for (const [symbol, address] of Object.entries(chain.tokens)) {
      assert.ok(ADDRESS(address), `${key} ${symbol} address`);
    }
  });
}

test("Robinhood Chain registry matches official network and token data", () => {
  const chain = CHAINS.robinhood;
  assert.equal(chain.chainId, 4663);
  assert.equal(chain.wrappedNative, "WETH");
  assert.equal(chain.tokens.WETH, getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73"));
  assert.equal(chain.tokens.USDG, getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168"));
  assert.ok(chain.rpcUrls.includes("https://rpc.mainnet.chain.robinhood.com"));
});

test("loadConfig resolves chain presets and aliases without positions", () => {
  for (const [chain, chainId] of [["ethereum", 1], ["bsc", 56], ["orbit", 4663]]) {
    const config = loadConfig({ chain, allowEmptyPositions: true });
    assert.equal(config.chainId, chainId);
    assert.ok(config.rpcUrls.length >= 1);
    assert.equal(config.rpcUrl, config.rpcUrls[0]);
  }
});

test("per-chain .env RPC vars build independent, deduped routes", () => {
  withEnv({
    RPC_URL: "",
    ETH_RPC_URL: "https://eth.primary.example",
    ETH_RPC_URLS: "https://eth.secondary.example, https://eth.primary.example",
    ETHEREUM_RPC_URL: null,
    ETHEREUM_RPC_URLS: null,
    BSC_RPC_URL: "https://bsc.primary.example",
    BSC_RPC_URLS: null,
    BNB_RPC_URL: null,
    BNB_RPC_URLS: null,
    BASE_RPC_URL: null,
    BASE_RPC_URLS: "https://base.one.example https://base.two.example",
    ROBINHOOD_RPC_URL: "https://robinhood.primary.example",
    ROBINHOOD_RPC_URLS: null,
    RHC_RPC_URL: null,
    RHC_RPC_URLS: null,
    ARBITRUM_RPC_URL: null,
    ARBITRUM_RPC_URLS: null,
    ARB_RPC_URL: null,
    ARB_RPC_URLS: null,
  }, () => {
    const config = loadConfig({ chain: "arbitrum", allowEmptyPositions: true });

    assert.equal(config.rpcByChain.ethereum[0], "https://eth.primary.example");
    assert.equal(config.rpcByChain.ethereum[1], "https://eth.secondary.example");
    assert.equal(
      config.rpcByChain.ethereum.filter((url) => url === "https://eth.primary.example").length,
      1,
    );
    assert.equal(config.rpcByChain.bnb[0], "https://bsc.primary.example");
    assert.deepEqual(config.rpcByChain.base.slice(0, 2), [
      "https://base.one.example",
      "https://base.two.example",
    ]);
    assert.equal(config.rpcByChain.robinhood[0], "https://robinhood.primary.example");
  });
});

test("positions resolve their own chain from chain or chainId", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpheus-config-"));
  const configPath = path.join(dir, "user-config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    chain: "ethereum",
    positions: [
      { label: "bsc-desk", chain: "bsc", token0: "WBNB", token1: "USDT", fee: 500 },
      { label: "rh-desk", chainId: 4663, token0: "WETH", token1: "USDG", fee: 100 },
      { label: "eth-desk", token0: "WETH", token1: "USDC", fee: 500 },
    ],
  }));

  try {
    const config = loadConfig({ chain: "ethereum", configPath, allowEmptyPositions: true });
    assert.equal(config.positions[0].chain, "bnb");
    assert.equal(config.positions[0].chainId, 56);
    assert.equal(config.positions[0].token0, CHAINS.bnb.tokens.WBNB);
    assert.equal(config.positions[1].chain, "robinhood");
    assert.equal(config.positions[1].chainId, 4663);
    assert.equal(config.positions[1].token1, CHAINS.robinhood.tokens.USDG);
    assert.equal(config.positions[2].chain, "ethereum");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("indexer env vars map per chain and fall back to INDEXER_API_URL", () => {
  withEnv({
    INDEXER_API_URL: "https://indexer.example/graphql",
    INDEXER_API_TYPE: "graphql",
    INDEXER_API_KEY: "secret",
    INDEXER_TIMEOUT_MS: "5000",
    SUBGRAPH_URL_4663: "https://robinhood.example/graphql",
  }, () => {
    const config = loadConfig({ allowEmptyPositions: true });
    assert.equal(config.indexer.enabled, true);
    assert.equal(config.indexer.url, "https://indexer.example/graphql");
    assert.equal(config.indexer.type, "graphql");
    assert.equal(config.indexer.apiKey, "secret");
    assert.equal(config.indexer.timeoutMs, 5000);
    assert.equal(
      config.indexer.byChain.robinhood,
      "https://robinhood.example/graphql",
    );
    assert.equal(config.indexer.byChain.base, undefined);
  });
});

test("INDEXER_API_URL validation is skipped for subgraph and empty URLs", () => {
  withEnv({
    INDEXER_API_TYPE: "subgraph",
    INDEXER_API_URL: "not-a-url",
  }, () => {
    const config = loadConfig({ allowEmptyPositions: true });
    assert.equal(config.indexer.type, "subgraph");
    assert.ok(
      !config.warnings.some((warning) => warning.includes("INDEXER_API_URL is not")),
    );
  });

  withEnv({
    INDEXER_API_TYPE: "generic",
    INDEXER_API_URL: "",
  }, () => {
    const config = loadConfig({ allowEmptyPositions: true });
    assert.ok(
      !config.warnings.some((warning) => warning.includes("INDEXER_API_URL is not")),
    );
  });

  withEnv({
    INDEXER_API_TYPE: "api",
    INDEXER_API_URL: "not-a-url",
  }, () => {
    const config = loadConfig({ allowEmptyPositions: true });
    assert.equal(config.indexer.url, "");
    assert.ok(
      config.warnings.some((warning) => warning.includes("INDEXER_API_URL is not")),
    );
  });

  withEnv({
    INDEXER_API_TYPE: "generic",
    INDEXER_API_URL: "https://indexer.example/api",
  }, () => {
    const config = loadConfig({ allowEmptyPositions: true });
    assert.equal(config.indexer.url, "https://indexer.example/api");
    assert.ok(
      !config.warnings.some((warning) => warning.includes("INDEXER_API_URL is not")),
    );
  });
});

test("chainRuntimeConfig swaps chain metadata and its RPC route", () => {
  const config = loadConfig({ chain: "base", allowEmptyPositions: true });
  const bnb = chainRuntimeConfig(config, "bsc");

  assert.equal(bnb.chain, "bnb");
  assert.equal(bnb.chainId, 56);
  assert.equal(bnb.factory, CHAINS.bnb.factory);
  assert.equal(bnb.positionManager, CHAINS.bnb.positionManager);
  assert.equal(bnb.rpcUrl, config.rpcByChain.bnb[0]);
  assert.deepEqual(bnb.rpcUrls, config.rpcByChain.bnb);
});

test("environment aliases map to wallet, shadow mode and health port", () => {
  const privateKey = `0x${"11".repeat(32)}`;
  withEnv({
    CHAIN: "base",
    DRY_RUN: null,
    SHADOW_MODE: "false",
    I_UNDERSTAND_LIVE_TRADING: "true",
    WALLET_PRIVATE_KEY: privateKey,
    PRIVATE_KEY: null,
    PORT: "4321",
    HEALTH_ENABLED: "true",
    HEALTH_PORT: null,
  }, () => {
    const config = loadConfig({ allowEmptyPositions: true });
    assert.equal(config.chain, "base");
    assert.equal(config.dryRun, false);
    assert.equal(config.liveRequested, true);
    assert.equal(config.privateKey, privateKey);
    assert.equal(config.health.enabled, true);
    assert.equal(config.health.port, 4321);
  });
});

test("DRY_RUN takes precedence over SHADOW_MODE and warns on conflict", () => {
  withEnv({
    DRY_RUN: "true",
    SHADOW_MODE: "false",
    I_UNDERSTAND_LIVE_TRADING: "false",
  }, () => {
    const config = loadConfig({ allowEmptyPositions: true });
    assert.equal(config.dryRun, true);
    assert.match(config.warnings.join(" "), /DRY_RUN and SHADOW_MODE disagree/);
  });
});

test("empty positions are allowed when wallet discovery is enabled", () => {
  withEnv({ DISCOVERY_ENABLED: null, DISCOVERY_WALLET: null }, () => {
    const config = loadConfig({ allowEmptyPositions: false });
    assert.equal(config.positions.length, 0);
    assert.equal(config.discovery.enabled, true);
  });
});

test("empty positions still fail when discovery is explicitly disabled", () => {
  withEnv({ DISCOVERY_ENABLED: "false", DISCOVERY_WALLET: null }, () => {
    assert.throws(
      () => loadConfig({ allowEmptyPositions: false }),
      /no positions configured and discovery is disabled/,
    );
  });
});

function ADDRESS(value) {
  try {
    getAddress(value);
    return true;
  } catch {
    return false;
  }
}

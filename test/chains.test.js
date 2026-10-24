import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "ethers";

import { CHAINS, chainInfo, loadConfig } from "../config.js";

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

function ADDRESS(value) {
  try {
    getAddress(value);
    return true;
  } catch {
    return false;
  }
}

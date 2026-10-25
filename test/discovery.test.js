import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import {
  clearDiscoveryCache,
  configuredWallet,
  discoverWalletPositions,
  mergePositions,
} from "../tools/discovery.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const WALLET = new Wallet(PRIVATE_KEY).address;

function onchainPosition(tokenId, pool) {
  return {
    tokenId,
    pool,
    token0: "0x3333333333333333333333333333333333333333",
    token1: "0x4444444444444444444444444444444444444444",
    token0Symbol: "WETH",
    token1Symbol: "USDC",
    fee: 100,
    tickLower: -120,
    tickUpper: 120,
  };
}

test("configuredWallet derives the address from the private key", () => {
  assert.equal(configuredWallet({ privateKey: PRIVATE_KEY }), WALLET);
  const explicit = "0x2222222222222222222222222222222222222222";
  assert.equal(
    configuredWallet({ privateKey: PRIVATE_KEY, discovery: { wallet: explicit } }),
    explicit,
  );
  assert.equal(configuredWallet({}), null);
});

test("mergePositions deduplicates by chain, pool and tokenId", () => {
  const a = { chain: "base", pool: "0xabc", tokenId: "1", label: "a" };
  const duplicate = { ...a, label: "copy" };
  const b = { chain: "bnb", pool: "0xabc", tokenId: "1", label: "b" };
  const merged = mergePositions([a], [duplicate, b]);
  assert.deepEqual(merged.map((position) => position.label), ["a", "b"]);
});

test("discovers positions on every configured chain and caches briefly", async () => {
  clearDiscoveryCache();
  let discoveryCalls = 0;
  const router = {
    get: (chainKey) => ({
      getWalletPositions: async (owner, options) => {
        discoveryCalls += 1;
        assert.equal(owner, WALLET);
        assert.equal(options.limit, 5);
        return chainKey === "base"
          ? [onchainPosition("7", `0x${"a".repeat(40)}`)]
          : [];
      },
      resolveBaseToken: async () => "0x4444444444444444444444444444444444444444",
    }),
  };
  const config = {
    privateKey: PRIVATE_KEY,
    discovery: { enabled: true, wallet: "", maxPositions: 5 },
    rpcByChain: { base: ["https://base.example"], bnb: ["https://bsc.example"] },
  };

  const first = await discoverWalletPositions({ config, router, refresh: true });
  assert.equal(first.wallet, WALLET);
  assert.equal(first.positions.length, 1);
  assert.equal(first.positions[0].chain, "base");
  assert.equal(first.positions[0].tokenId, "7");
  assert.equal(first.positions[0].state.token0Symbol, "WETH");
  assert.deepEqual(first.chains.sort(), ["base", "bnb"]);
  assert.equal(discoveryCalls, 2);

  const cached = await discoverWalletPositions({ config, router });
  assert.equal(cached.cached, true);
  assert.equal(discoveryCalls, 2);
});

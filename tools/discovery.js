// ─── Wallet LP auto-discovery ─────────────────────────────────────────
// Shared by startup and the Telegram command menu. Discovery is read-only and
// scans every configured chain for Uniswap v3 NFT positions owned by the wallet.

import { Wallet } from "ethers";
import { chainInfo } from "../config.js";
import { log } from "../logger.js";
import { positionKey } from "./position-key.js";

const CACHE_TTL_MS = 15_000;
const cache = new Map();

/** Explicit discovery wallet, or the address derived from the configured key. */
export function configuredWallet(config) {
  if (config?.discovery?.wallet) return config.discovery.wallet;
  if (config?.privateKey) {
    try {
      return new Wallet(config.privateKey).address;
    } catch {
      return null;
    }
  }
  return null;
}

export function mergePositions(existing = [], discovered = []) {
  const merged = [...existing];
  const seen = new Set(existing.map((position) => positionKey(position)));
  for (const position of discovered) {
    const key = positionKey(position);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(position);
  }
  return merged;
}

/**
 * Discover wallet positions across all configured chains.
 * Results are cached briefly so repeated Telegram commands do not hammer RPC.
 */
export async function discoverWalletPositions({
  config,
  router,
  owner = null,
  chains = null,
  limit = null,
  refresh = false,
  cacheMs = CACHE_TTL_MS,
} = {}) {
  const wallet = owner || configuredWallet(config);
  if (!wallet || !router) {
    return { wallet, positions: [], errors: [], chains: [] };
  }

  const chainKeys = (Array.isArray(chains) && chains.length
    ? chains
    : Object.keys(config.rpcByChain || {}))
    .map((chainKey) => chainInfo(chainKey).key);
  const uniqueChains = [...new Set(chainKeys)];
  const maxPositions = Math.max(1, Number(limit || config.discovery?.maxPositions) || 10);
  const cacheKey = `${wallet.toLowerCase()}:${uniqueChains.join(",")}:${maxPositions}`;

  const cached = cache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.at < cacheMs) {
    return { ...cached.value, cached: true };
  }

  const errors = [];
  const discovered = [];

  const results = await Promise.allSettled(uniqueChains.map(async (chainKey) => {
    const chain = chainInfo(chainKey);
    const client = router.get(chainKey);
    const onchainPositions = await client.getWalletPositions(wallet, { limit: maxPositions });
    const positions = [];

    for (const onchain of onchainPositions) {
      let baseToken = null;
      try {
        baseToken = await client.resolveBaseToken(onchain.pool, null);
      } catch (error) {
        log("panda_warn", `Base-token resolution failed for ${onchain.pool}: ${error.message}`);
      }
      positions.push({
        label: `wallet-${onchain.tokenId}`,
        chain: chain.key,
        chainId: chain.chainId,
        pool: onchain.pool,
        tokenId: onchain.tokenId,
        token0: onchain.token0,
        token1: onchain.token1,
        baseToken,
        fee: onchain.fee,
        amountUsd: null,
        notes: "discovered on-chain",
        state: onchain,
        onchain,
      });
    }
    return positions;
  }));

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      discovered.push(...result.value);
    } else {
      const chainKey = uniqueChains[index];
      const message = result.reason?.shortMessage || result.reason?.message || String(result.reason);
      errors.push(`${chainKey}: ${message}`);
      log("panda_warn", `Wallet discovery failed on ${chainKey}: ${message}`);
    }
  });

  const positions = mergePositions([], discovered);
  const value = { wallet, positions, errors, chains: uniqueChains };
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return value;
}

/** Clear the short-lived discovery cache (used on shutdown in tests). */
export function clearDiscoveryCache() {
  cache.clear();
}

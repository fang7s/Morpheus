// ─── Uniswap v3 position manager + slot0 price reader (ethers v6) ───
// Read-only helpers work without a private key. Every write path is guarded by
// config.dryRun so shadow mode can never broadcast a transaction.

import {
  Contract,
  FallbackProvider,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  parseUnits,
} from "ethers";
import { log } from "../logger.js";

const Q96 = 2n ** 96n;
const MAX_UINT128 = (2n ** 128n) - 1n;
const BPS = 10_000n;

export const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
];

export const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

export const NPM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable returns ()",
  "function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];

export const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

function sortTokens(tokenA, tokenB) {
  const a = String(tokenA).toLowerCase();
  const b = String(tokenB).toLowerCase();
  return a < b ? [tokenA, tokenB] : [tokenB, tokenA];
}

function serializePosition(raw) {
  return {
    nonce: raw.nonce.toString(),
    operator: raw.operator,
    token0: raw.token0,
    token1: raw.token1,
    fee: Number(raw.fee),
    tickLower: Number(raw.tickLower),
    tickUpper: Number(raw.tickUpper),
    liquidity: raw.liquidity.toString(),
    feeGrowthInside0LastX128: raw.feeGrowthInside0LastX128.toString(),
    feeGrowthInside1LastX128: raw.feeGrowthInside1LastX128.toString(),
    tokensOwed0: raw.tokensOwed0.toString(),
    tokensOwed1: raw.tokensOwed1.toString(),
  };
}

/**
 * Convert a sqrtPriceX96 value to token1-per-token0 human units.
 * @param {bigint|string|number} sqrtPriceX96
 * @param {number} decimals0
 * @param {number} decimals1
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
  const ratio = Number(BigInt(sqrtPriceX96)) / (2 ** 96);
  return (ratio * ratio) * (10 ** (Number(decimals0) - Number(decimals1)));
}

/** Convert a tick to token1-per-token0 human units. */
export function tickToPrice(tick, decimals0, decimals1) {
  return (1.0001 ** Number(tick)) * (10 ** (Number(decimals0) - Number(decimals1)));
}

/** Convert a token1-per-token0 human price to a (fractional) tick. */
export function priceToTick(price, decimals0, decimals1) {
  const raw = Number(price) / (10 ** (Number(decimals0) - Number(decimals1)));
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`Cannot convert price ${price} to tick`);
  }
  return Math.log(raw) / Math.log(1.0001);
}

/** Round a tick to the pool's tick spacing. */
export function nearestUsableTick(tick, tickSpacing) {
  const spacing = Math.max(1, Math.floor(Number(tickSpacing) || 1));
  return Math.round(Number(tick) / spacing) * spacing;
}

/** sqrt(1.0001^tick) scaled by 2^96 (precision sufficient for min amounts). */
export function tickToSqrtPriceX96(tick) {
  const sqrt = Math.sqrt(1.0001 ** Number(tick));
  return BigInt(Math.floor(sqrt * (2 ** 96)));
}

/** Uniswap v3 amount0 formula for a liquidity range. */
export function getAmount0ForLiquidity(sqrtA, sqrtB, liquidity) {
  let a = BigInt(sqrtA);
  let b = BigInt(sqrtB);
  if (a > b) [a, b] = [b, a];
  if (a === 0n) return 0n;
  return (BigInt(liquidity) * (b - a) * Q96) / (b * a);
}

/** Uniswap v3 amount1 formula for a liquidity range. */
export function getAmount1ForLiquidity(sqrtA, sqrtB, liquidity) {
  let a = BigInt(sqrtA);
  let b = BigInt(sqrtB);
  if (a > b) [a, b] = [b, a];
  return (BigInt(liquidity) * (b - a)) / Q96;
}

/**
 * Token amounts backing `liquidity` at the current price.
 * @returns {{amount0:bigint, amount1:bigint}}
 */
export function getAmountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity) {
  const current = BigInt(sqrtPriceX96);
  const lower = tickToSqrtPriceX96(tickLower);
  const upper = tickToSqrtPriceX96(tickUpper);
  const L = BigInt(liquidity);

  if (L === 0n) return { amount0: 0n, amount1: 0n };
  if (current <= lower) {
    return { amount0: getAmount0ForLiquidity(lower, upper, L), amount1: 0n };
  }
  if (current < upper) {
    return {
      amount0: getAmount0ForLiquidity(current, upper, L),
      amount1: getAmount1ForLiquidity(lower, current, L),
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(lower, upper, L) };
}

/**
 * Build a read provider from the chain's RPC presets. With more than one URL,
 * ethers' FallbackProvider (quorum 1) transparently fails over between them.
 */
function createReadProvider(config) {
  const urls = [...new Set([
    config.rpcUrl,
    ...(Array.isArray(config.rpcUrls) ? config.rpcUrls : []),
  ].filter(Boolean))];
  if (urls.length === 0) throw new Error("UniswapV3 requires at least one RPC URL");

  const providerOptions = { staticNetwork: true };
  if (urls.length === 1) {
    return new JsonRpcProvider(urls[0], config.chainId, providerOptions);
  }

  const entries = urls.map((url, index) => ({
    provider: new JsonRpcProvider(url, config.chainId, providerOptions),
    priority: index + 1,
    stallTimeout: 2_500,
    weight: 1,
  }));

  try {
    const fallback = new FallbackProvider(entries, config.chainId, { quorum: 1 });
    log("startup", `RPC fallback enabled across ${urls.length} presets.`);
    return fallback;
  } catch (error) {
    log("startup_warn", `RPC fallback unavailable (${error.message}); using ${urls[0]}`);
    for (const entry of entries) entry.provider.destroy();
    return new JsonRpcProvider(urls[0], config.chainId, providerOptions);
  }
}

/**
 * Thin Uniswap v3 client for Arbitrum, Base, Ethereum, BNB Chain and
 * Robinhood Chain. Reads use the provider; writes require Wallet + dryRun=false.
 */
export class UniswapV3 {
  constructor(config) {
    if (!config?.rpcUrl) throw new Error("UniswapV3 requires config.rpcUrl");
    if (!config?.chainId) throw new Error("UniswapV3 requires config.chainId");

    this.config = config;
    this.chain = config.chain;
    this.provider = createReadProvider(config);
    this.signer = !config.dryRun && config.privateKey
      ? new Wallet(config.privateKey, this.provider)
      : null;
    let derivedWallet = null;
    if (config.privateKey) {
      try {
        derivedWallet = new Wallet(config.privateKey).address;
      } catch {
        // Invalid keys are reported by config validation in live mode.
      }
    }
    this.walletAddress = this.signer?.address || config.discovery?.wallet || derivedWallet || null;

    this.factory = new Contract(config.factory, FACTORY_ABI, this.provider);
    this.npm = new Contract(
      config.positionManager,
      NPM_ABI,
      this.signer || this.provider,
    );

    this.poolContracts = new Map();
    this.poolStates = new Map();
    this.tokenMetaCache = new Map();
  }

  get dryRun() {
    return this.config.dryRun !== false;
  }

  getPoolContract(poolAddress) {
    const key = String(poolAddress).toLowerCase();
    if (!this.poolContracts.has(key)) {
      this.poolContracts.set(key, new Contract(poolAddress, POOL_ABI, this.provider));
    }
    return this.poolContracts.get(key);
  }

  getTokenContract(tokenAddress) {
    return new Contract(tokenAddress, ERC20_ABI, this.signer || this.provider);
  }

  /** Cached ERC20 metadata. Falls back to 18 decimals for non-standard tokens. */
  async getTokenMeta(tokenAddress) {
    const key = String(tokenAddress).toLowerCase();
    if (!this.tokenMetaCache.has(key)) {
      this.tokenMetaCache.set(key, (async () => {
        const token = this.getTokenContract(tokenAddress);
        let decimals = 18;
        let symbol = null;
        try {
          decimals = Number(await token.decimals());
        } catch (error) {
          log("panda_warn", `decimals() failed for ${tokenAddress}: ${error.message}`);
        }
        try {
          symbol = await token.symbol();
        } catch {
          symbol = null;
        }
        return { address: tokenAddress, decimals, symbol };
      })());
    }
    return this.tokenMetaCache.get(key);
  }

  /** Resolve a v3 pool address from tokens + fee tier (token order agnostic). */
  async getPoolAddress({ tokenA, tokenB, fee }) {
    if (!tokenA || !tokenB) throw new Error("getPoolAddress requires tokenA and tokenB");
    if (fee == null) throw new Error("getPoolAddress requires a fee tier");
    const [token0, token1] = sortTokens(tokenA, tokenB);
    const pool = await this.factory.getPool(token0, token1, Number(fee));
    if (!pool || /^0x0{40}$/i.test(pool)) {
      throw new Error(`No Uniswap v3 pool for ${tokenA}/${tokenB} fee=${fee}`);
    }
    return pool;
  }

  /** Read pool identity, liquidity, slot0 and human token1-per-token0 price. */
  async getPoolState(poolAddress, { refresh = false } = {}) {
    const key = String(poolAddress).toLowerCase();
    const cached = this.poolStates.get(key);
    if (!refresh && cached && Date.now() - cached.at < 3_000) return cached.value;

    const pool = this.getPoolContract(poolAddress);
    const [slot0, token0, token1, fee, tickSpacing, liquidity, blockNumber] = await Promise.all([
      pool.slot0(),
      pool.token0(),
      pool.token1(),
      pool.fee(),
      pool.tickSpacing(),
      pool.liquidity(),
      this.provider.getBlockNumber(),
    ]);
    const [meta0, meta1] = await Promise.all([
      this.getTokenMeta(token0),
      this.getTokenMeta(token1),
    ]);

    const value = {
      pool: poolAddress,
      token0,
      token1,
      token0Symbol: meta0.symbol,
      token1Symbol: meta1.symbol,
      decimals0: meta0.decimals,
      decimals1: meta1.decimals,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      sqrtPriceX96: slot0.sqrtPriceX96.toString(),
      tick: Number(slot0.tick),
      liquidity: liquidity.toString(),
      price: sqrtPriceX96ToPrice(slot0.sqrtPriceX96, meta0.decimals, meta1.decimals),
      blockNumber,
      fetchedAt: new Date().toISOString(),
    };
    this.poolStates.set(key, { at: Date.now(), value });
    return value;
  }

  /** Slot0-only read (cheapest fallback for the price pipeline). */
  async getSlot0(poolAddress) {
    const pool = this.getPoolContract(poolAddress);
    const [slot0, token0, token1] = await Promise.all([
      pool.slot0(),
      pool.token0(),
      pool.token1(),
    ]);
    const [meta0, meta1] = await Promise.all([
      this.getTokenMeta(token0),
      this.getTokenMeta(token1),
    ]);
    return {
      pool: poolAddress,
      token0,
      token1,
      sqrtPriceX96: slot0.sqrtPriceX96.toString(),
      tick: Number(slot0.tick),
      price: sqrtPriceX96ToPrice(slot0.sqrtPriceX96, meta0.decimals, meta1.decimals),
    };
  }

  /** Human price of token0 quoted in token1. */
  async getPoolPrice(poolAddress) {
    const state = await this.getSlot0(poolAddress);
    return state.price;
  }

  /**
   * Price oriented so `baseToken` is the base. Inverts token1-per-token0 when
   * the requested base is token1.
   */
  async getPriceInBase(poolAddress, baseToken) {
    const state = await this.getSlot0(poolAddress);
    const base = String(baseToken || "").toLowerCase();
    if (base === String(state.token1).toLowerCase()) {
      return state.price > 0 ? 1 / state.price : null;
    }
    return state.price;
  }

  /**
   * Pick a sensible base token: requested base, else the chain's wrapped native
   * (WETH/WBNB) if present, else token0.
   */
  async resolveBaseToken(poolAddress, preferredBase) {
    const state = await this.getSlot0(poolAddress);
    if (preferredBase) return preferredBase;
    const chain = this.config.chainConfig;
    const wrappedSymbol = chain?.wrappedNative || "WETH";
    const wrapped = chain?.tokens?.[wrappedSymbol]
      || chain?.tokens?.WETH
      || chain?.tokens?.WBNB;
    if (wrapped && [state.token0, state.token1]
      .some((token) => String(token).toLowerCase() === String(wrapped).toLowerCase())) {
      return wrapped;
    }
    return state.token0;
  }

  /** Full position snapshot with human amounts and in-range flag. */
  async getPosition(tokenId, { refresh = false } = {}) {
    const raw = await this.npm.positions(tokenId);
    const position = serializePosition(raw);
    const poolAddress = await this.getPoolAddress({
      tokenA: position.token0,
      tokenB: position.token1,
      fee: position.fee,
    });
    const state = await this.getPoolState(poolAddress, { refresh });
    const amounts = getAmountsForLiquidity(
      state.sqrtPriceX96,
      position.tickLower,
      position.tickUpper,
      position.liquidity,
    );

    return {
      tokenId: String(tokenId),
      pool: poolAddress,
      ...position,
      token0Symbol: state.token0Symbol,
      token1Symbol: state.token1Symbol,
      decimals0: state.decimals0,
      decimals1: state.decimals1,
      sqrtPriceX96: state.sqrtPriceX96,
      currentTick: state.tick,
      currentPrice: state.price,
      priceLower: tickToPrice(position.tickLower, state.decimals0, state.decimals1),
      priceUpper: tickToPrice(position.tickUpper, state.decimals0, state.decimals1),
      amount0: formatUnits(amounts.amount0, state.decimals0),
      amount1: formatUnits(amounts.amount1, state.decimals1),
      tokensOwed0: formatUnits(position.tokensOwed0, state.decimals0),
      tokensOwed1: formatUnits(position.tokensOwed1, state.decimals1),
      inRange: state.tick >= position.tickLower && state.tick < position.tickUpper,
    };
  }

  /** Token IDs owned by an address (NPM implements ERC721Enumerable). */
  async getWalletTokenIds(owner, { limit = 50 } = {}) {
    if (!owner) throw new Error("getWalletTokenIds requires an owner address");
    let balance = 0;
    try {
      balance = Number(await this.npm.balanceOf(owner));
    } catch (error) {
      log("panda_warn", `NPM balanceOf failed for ${owner}: ${error.message}`);
      return [];
    }
    const count = Math.min(balance, Math.max(1, Number(limit) || 50));
    const tokenIds = [];
    for (let i = 0; i < count; i++) {
      try {
        const id = await this.npm.tokenOfOwnerByIndex(owner, i);
        tokenIds.push(id.toString());
      } catch (error) {
        log("panda_warn", `tokenOfOwnerByIndex(${i}) failed: ${error.message}`);
        break;
      }
    }
    return tokenIds;
  }

  /** Full snapshots for every NPM position owned by `owner`. */
  async getWalletPositions(owner, options = {}) {
    const tokenIds = await this.getWalletTokenIds(owner, options);
    const positions = [];
    for (const tokenId of tokenIds) {
      try {
        positions.push(await this.getPosition(tokenId, options));
      } catch (error) {
        log("panda_warn", `Failed to read position ${tokenId}: ${error.message}`);
      }
    }
    return positions;
  }

  _requireSigner(action) {
    if (this.dryRun) throw new Error(`${action} blocked: dry-run/shadow mode is ON`);
    if (!this.signer) throw new Error(`${action} requires PRIVATE_KEY`);
    return this.npm.connect(this.signer);
  }

  _minAmount(amount, slippageBps) {
    const slippage = BigInt(Math.min(9_999, Math.max(0, Math.floor(slippageBps))));
    return (BigInt(amount) * (BPS - slippage)) / BPS;
  }

  /**
   * Exit an LP position: remove all liquidity, collect principal + fees, then
   * optionally burn the empty NFT. Never callable in dry-run mode.
   */
  async closePosition(tokenId, {
    burn = true,
    slippageBps = 100,
    recipient = null,
    deadlineSec = 1_200,
  } = {}) {
    const npm = this._requireSigner("closePosition");
    const owner = recipient || this.signer.address;
    const position = await this.getPosition(tokenId, { refresh: true });
    const state = await this.getPoolState(position.pool, { refresh: true });
    const liquidity = BigInt(position.liquidity);
    const deadline = Math.floor(Date.now() / 1_000) + Math.max(60, Number(deadlineSec) || 1_200);
    const txHashes = [];

    if (liquidity > 0n) {
      const amounts = getAmountsForLiquidity(
        state.sqrtPriceX96,
        position.tickLower,
        position.tickUpper,
        liquidity,
      );
      const tx = await npm.decreaseLiquidity({
        tokenId: BigInt(tokenId),
        liquidity,
        amount0Min: this._minAmount(amounts.amount0, slippageBps),
        amount1Min: this._minAmount(amounts.amount1, slippageBps),
        deadline,
      });
      const receipt = await tx.wait();
      txHashes.push(receipt.hash);
    }

    const collectTx = await npm.collect({
      tokenId: BigInt(tokenId),
      recipient: owner,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    });
    const collectReceipt = await collectTx.wait();
    txHashes.push(collectReceipt.hash);

    let burned = false;
    if (burn && liquidity > 0n) {
      const burnTx = await npm.burn(BigInt(tokenId));
      const burnReceipt = await burnTx.wait();
      txHashes.push(burnReceipt.hash);
      burned = true;
    }

    log(
      "panda",
      `Closed position ${tokenId} on ${this.chain}: ${position.token0Symbol}/${position.token1Symbol} | ${txHashes.length} tx`,
    );
    return {
      tokenId: String(tokenId),
      pool: position.pool,
      liquidityRemoved: liquidity.toString(),
      burned,
      recipient: owner,
      txHashes,
    };
  }

  /** Collect accrued fees without touching liquidity. */
  async collectFees(tokenId, recipient = null) {
    const npm = this._requireSigner("collectFees");
    const tx = await npm.collect({
      tokenId: BigInt(tokenId),
      recipient: recipient || this.signer.address,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    });
    const receipt = await tx.wait();
    return { tokenId: String(tokenId), txHash: receipt.hash };
  }

  /** Approve the NPM to spend `amount` of an ERC20 when needed. */
  async ensureAllowance(tokenAddress, amount) {
    if (this.dryRun) throw new Error("ensureAllowance blocked: dry-run/shadow mode is ON");
    if (!this.signer) throw new Error("ensureAllowance requires PRIVATE_KEY");
    const token = new Contract(tokenAddress, ERC20_ABI, this.signer);
    const owner = this.signer.address;
    const current = await token.allowance(owner, this.config.positionManager);
    if (BigInt(current) >= BigInt(amount)) return null;
    const tx = await token.approve(this.config.positionManager, BigInt(amount));
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Mint a concentrated range (live mode only).
   * `priceLower`/`priceUpper` are tokenB-per-tokenA human prices; the pool's
   * sorted token order is handled internally.
   */
  async mintPosition({
    tokenA,
    tokenB,
    fee,
    amount0,
    amount1,
    priceLower,
    priceUpper,
    slippageBps = 100,
    recipient = null,
    deadlineSec = 1_200,
  }) {
    const npm = this._requireSigner("mintPosition");
    const pool = await this.getPoolAddress({ tokenA, tokenB, fee });
    const state = await this.getPoolState(pool, { refresh: true });
    const spacing = Math.max(1, state.tickSpacing);

    // Convert tokenB-per-tokenA prices into the pool's token1-per-token0 order.
    const tokenAIs0 = String(state.token0).toLowerCase() === String(tokenA).toLowerCase();
    const poolLower = tokenAIs0 ? Number(priceLower) : 1 / Number(priceUpper);
    const poolUpper = tokenAIs0 ? Number(priceUpper) : 1 / Number(priceLower);

    const tickLower = nearestUsableTick(
      priceToTick(poolLower, state.decimals0, state.decimals1),
      spacing,
    );
    const tickUpper = nearestUsableTick(
      priceToTick(poolUpper, state.decimals0, state.decimals1),
      spacing,
    );
    if (tickLower >= tickUpper) throw new Error("priceLower must be below priceUpper");

    const rawA = parseUnits(String(amount0), tokenAIs0 ? state.decimals0 : state.decimals1);
    const rawB = parseUnits(String(amount1), tokenAIs0 ? state.decimals1 : state.decimals0);
    if (rawA <= 0n && rawB <= 0n) throw new Error("mintPosition requires a non-zero amount");
    const raw0 = tokenAIs0 ? rawA : rawB;
    const raw1 = tokenAIs0 ? rawB : rawA;

    if (raw0 > 0n) await this.ensureAllowance(state.token0, raw0);
    if (raw1 > 0n) await this.ensureAllowance(state.token1, raw1);

    const deadline = Math.floor(Date.now() / 1_000) + Math.max(60, Number(deadlineSec) || 1_200);
    const tx = await npm.mint({
      token0: state.token0,
      token1: state.token1,
      fee: state.fee,
      tickLower,
      tickUpper,
      amount0Desired: raw0,
      amount1Desired: raw1,
      amount0Min: this._minAmount(raw0, slippageBps),
      amount1Min: this._minAmount(raw1, slippageBps),
      recipient: recipient || this.signer.address,
      deadline,
    });
    const receipt = await tx.wait();

    let tokenId = null;
    for (const entry of receipt.logs) {
      try {
        const parsed = this.npm.interface.parseLog(entry);
        if (parsed?.name === "IncreaseLiquidity") tokenId = parsed.args.tokenId.toString();
      } catch {
        // Logs from other contracts are ignored.
      }
    }

    return {
      tokenId,
      pool,
      tickLower,
      tickUpper,
      txHash: receipt.hash,
      token0: state.token0,
      token1: state.token1,
      fee: state.fee,
    };
  }

  /** Add liquidity to an existing position (live mode only). */
  async increaseLiquidity(tokenId, { amount0, amount1, slippageBps = 100, deadlineSec = 1_200 }) {
    const npm = this._requireSigner("increaseLiquidity");
    const position = await this.getPosition(tokenId, { refresh: true });
    const raw0 = parseUnits(String(amount0), position.decimals0);
    const raw1 = parseUnits(String(amount1), position.decimals1);
    if (raw0 > 0n) await this.ensureAllowance(position.token0, raw0);
    if (raw1 > 0n) await this.ensureAllowance(position.token1, raw1);

    const deadline = Math.floor(Date.now() / 1_000) + Math.max(60, Number(deadlineSec) || 1_200);
    const tx = await npm.increaseLiquidity({
      tokenId: BigInt(tokenId),
      amount0Desired: raw0,
      amount1Desired: raw1,
      amount0Min: this._minAmount(raw0, slippageBps),
      amount1Min: this._minAmount(raw1, slippageBps),
      deadline,
    });
    const receipt = await tx.wait();
    return { tokenId: String(tokenId), txHash: receipt.hash };
  }

  /** Release the underlying provider's sockets. */
  destroy() {
    try {
      this.provider.destroy();
    } catch {
      // Provider may already be closed.
    }
  }
}

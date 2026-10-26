import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Interface } from "ethers";

import {
  DEPLOY_RANGES,
  allocateDeployAmounts,
  buildDeploymentPlan,
  buildMintParams,
  ceilToSpacing,
  clearDeploySessions,
  computeTickRange,
  encodeMintCalldata,
  evaluateAllowances,
  evaluateGas,
  evaluateSecurity,
  floorToSpacing,
  gasCost,
  normalizeTokenSecurity,
  parseTaxPercent,
  rangePriceBounds,
  resolveDeployPool,
  startDeployment,
  tickDeltaForPct,
} from "../tools/deploy.js";
import { NPM_ABI } from "../tools/uniswap-v3.js";
import {
  evaluateAutomation,
  formatManagementCard,
  handleManagementCallback,
  loadAutomations,
  managementKeyboard,
  upsertAutomation,
} from "../tools/position-manager.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const QUOTE = "0x2222222222222222222222222222222222222222";
const NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

function tempFile(name = "active-automations.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morpheus-deploy-"));
  return path.join(dir, name);
}

// ─── Security / tax guardrails ───────────────────────────────────────

test("parseTaxPercent normalizes GoPlus fractions and percentages", () => {
  assert.equal(parseTaxPercent("0.01"), 1);
  assert.equal(parseTaxPercent("0.005"), 0.5);
  assert.equal(parseTaxPercent("2.5"), 2.5);
  assert.equal(parseTaxPercent(""), null);
  assert.equal(parseTaxPercent("n/a"), null);
});

test("normalizeTokenSecurity reads transferability and tax fields", () => {
  const security = normalizeTokenSecurity({
    is_honeypot: "0",
    buy_tax: "0.005",
    sell_tax: "0.0075",
    is_transferable: "1",
    cannot_sell_all: "0",
    transfer_pausable: "1",
    is_open_source: "1",
    holder_count: "1234",
  });
  assert.equal(security.honeypot, false);
  assert.equal(security.buyTax, 0.5);
  assert.equal(security.sellTax, 0.75);
  assert.equal(security.transferable, true);
  assert.equal(security.transferPausable, true);
  assert.equal(security.holderCount, 1234);
  assert.equal(normalizeTokenSecurity({}), null);
});

test("security guardrail aborts on honeypot, disabled transfers and high tax", () => {
  const clean = evaluateSecurity({
    honeypot: false,
    buyTax: 0.5,
    sellTax: 0.25,
    transferable: true,
  });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.reasons, []);
  assert.equal(clean.checks.length, 2);

  const honeypot = evaluateSecurity({ honeypot: true, buyTax: 0, sellTax: 0 });
  assert.equal(honeypot.ok, false);
  assert.match(honeypot.reasons.join(" "), /Honeypot/);

  const blocked = evaluateSecurity({ transferable: false, buyTax: 0, sellTax: 0 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reasons.join(" "), /transfers/);

  const taxed = evaluateSecurity({ buyTax: 1.01, sellTax: 0.5 });
  assert.equal(taxed.ok, false);
  assert.match(taxed.reasons.join(" "), /Buy tax/);
});

test("missing security data fails closed unless explicitly allowed", () => {
  const strict = evaluateSecurity(null, { maxTaxPct: 1 });
  assert.equal(strict.ok, false);
  assert.match(strict.reasons.join(" "), /could not be verified/);

  const allowed = evaluateSecurity(null, { allowUnverified: true });
  assert.equal(allowed.ok, true);
  assert.match(allowed.warnings.join(" "), /DEPLOY_ALLOW_UNVERIFIED/);
});

// ─── Gas guardrail ───────────────────────────────────────────────────

test("gas guardrail compares estimated USD cost with MAX_GAS_FEE_USD", () => {
  // 20 gwei * 450k = 0.009 ETH; at $2000 = $18.
  const high = evaluateGas({
    gasPriceWei: 20_000_000_000n,
    gasLimit: 450_000,
    nativeUsdPrice: 2_000,
    maxGasFeeUsd: 0.5,
  });
  assert.equal(high.ok, false);
  assert.match(high.reason, /MAX_GAS_FEE_USD/);
  assert.ok(high.cost.usd > 0.5);

  // 0.05 gwei * 100k = 0.000005 ETH; at $2000 = $0.01.
  const low = evaluateGas({
    gasPriceWei: 50_000_000n,
    gasLimit: 100_000,
    nativeUsdPrice: 2_000,
    maxGasFeeUsd: 0.5,
  });
  assert.equal(low.ok, true);
  assert.ok(low.cost.usd < 0.5);

  const missingPrice = evaluateGas({
    gasPriceWei: 1n,
    gasLimit: 100_000,
    nativeUsdPrice: 0,
  });
  assert.equal(missingPrice.ok, false);
  assert.match(missingPrice.reason, /Native token USD price/);
});

test("gasCost converts wei and native decimals correctly", () => {
  const cost = gasCost({
    gasPriceWei: 1_000_000_000n,
    gasLimit: 1_000_000,
    nativeUsdPrice: 3_000,
  });
  assert.equal(cost.native, 0.001);
  assert.equal(cost.usd, 3);
});

// ─── Tick range math ─────────────────────────────────────────────────

test("tick deltas and spacing helpers match Uniswap v3 tick math", () => {
  // log(1.02)/log(1.0001) ≈ 198 ticks.
  assert.equal(tickDeltaForPct(2), 198);
  assert.equal(tickDeltaForPct(5), 488);
  assert.equal(floorToSpacing(199, 60), 180);
  assert.equal(ceilToSpacing(199, 60), 240);
  assert.equal(floorToSpacing(-199, 60), -240);
  assert.equal(ceilToSpacing(-199, 60), -180);
});

test("dual range is symmetric around the current tick and spacing-aligned", () => {
  const range = computeTickRange({
    tick: 0,
    tickSpacing: 60,
    rangePct: DEPLOY_RANGES.narrow.pct,
    side: "dual",
    baseIsToken0: true,
  });
  assert.equal(range.tickLower, -240);
  assert.equal(range.tickUpper, 240);
  assert.ok(range.tickLower % 60 === 0);
  assert.ok(range.tickUpper % 60 === 0);
  assert.ok(range.tickLower < 0 && range.tickUpper > 0);
});

test("single-side base range deposits only the base token", () => {
  const baseIsToken0 = computeTickRange({
    tick: 0,
    tickSpacing: 60,
    rangePct: 2,
    side: "base",
    baseIsToken0: true,
  });
  assert.equal(baseIsToken0.tickLower, 60);
  assert.equal(baseIsToken0.tickUpper, 240);

  const baseIsToken1 = computeTickRange({
    tick: 0,
    tickSpacing: 60,
    rangePct: 2,
    side: "base",
    baseIsToken0: false,
  });
  assert.equal(baseIsToken1.tickLower, -240);
  assert.equal(baseIsToken1.tickUpper, -60);
});

test("single-side quote range is the opposite side of the book", () => {
  const quoteWhenBaseIsToken0 = computeTickRange({
    tick: 0,
    tickSpacing: 60,
    rangePct: 2,
    side: "quote",
    baseIsToken0: true,
  });
  assert.equal(quoteWhenBaseIsToken0.tickLower, -240);
  assert.equal(quoteWhenBaseIsToken0.tickUpper, -60);

  const quoteWhenBaseIsToken1 = computeTickRange({
    tick: 0,
    tickSpacing: 60,
    rangePct: 2,
    side: "quote",
    baseIsToken0: false,
  });
  assert.equal(quoteWhenBaseIsToken1.tickLower, 60);
  assert.equal(quoteWhenBaseIsToken1.tickUpper, 240);
});

test("range prices invert when the base token is token1", () => {
  const asToken0 = rangePriceBounds({
    tickLower: -600,
    tickUpper: 600,
    decimals0: 18,
    decimals1: 18,
    baseIsToken0: true,
  });
  const asToken1 = rangePriceBounds({
    tickLower: -600,
    tickUpper: 600,
    decimals0: 18,
    decimals1: 18,
    baseIsToken0: false,
  });
  assert.ok(asToken0.priceLower > 0);
  assert.ok(asToken0.priceUpper > asToken0.priceLower);
  assert.ok(Math.abs(asToken1.priceLower - (1 / asToken0.priceUpper)) < 1e-18);
  assert.ok(Math.abs(asToken1.priceUpper - (1 / asToken0.priceLower)) < 1e-18);
});


// ─── Balance / allowance guardrail ───────────────────────────────────

test("allowance guardrail reports missing approvals and insufficient balances", () => {
  const requirements = [{ token: TOKEN, symbol: "BASE", amount: 1_000n }];
  const ok = evaluateAllowances({
    requirements,
    balances: { [TOKEN]: 5_000n },
    allowances: { [TOKEN]: 1_000n },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.missing.length, 0);

  const missing = evaluateAllowances({
    requirements,
    balances: { [TOKEN]: 5_000n },
    allowances: { [TOKEN]: 0n },
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.missing.length, 1);

  const poor = evaluateAllowances({
    requirements,
    balances: { [TOKEN]: 500n },
    allowances: { [TOKEN]: 1_000n },
  });
  assert.equal(poor.ok, false);
  assert.equal(poor.insufficient.length, 1);
});

test("deposit allocation follows side selection and wallet caps", () => {
  const dual = allocateDeployAmounts({
    side: "dual",
    budgetUsd: 100,
    baseUsdPrice: 2,
    quoteUsdPrice: 1,
    baseBalance: 25,
    quoteBalance: 1_000,
  });
  assert.equal(dual.baseAmount, 25);
  assert.equal(dual.quoteAmount, 50);
  assert.equal(dual.totalUsd, 100);

  const baseOnly = allocateDeployAmounts({
    side: "base",
    budgetUsd: 100,
    baseUsdPrice: 2,
    quoteUsdPrice: 1,
    baseBalance: 10,
    quoteBalance: 1_000,
  });
  assert.equal(baseOnly.baseAmount, 10);
  assert.equal(baseOnly.quoteAmount, 0);
  assert.equal(baseOnly.capped, true);
});

// ─── Transaction encoding ────────────────────────────────────────────

test("buildMintParams applies slippage to both minimum amounts", () => {
  const params = buildMintParams({
    token0: TOKEN,
    token1: QUOTE,
    fee: 3_000,
    tickLower: -600,
    tickUpper: 600,
    amount0Desired: 1_000_000n,
    amount1Desired: 2_000_000n,
    recipient: "0x3333333333333333333333333333333333333333",
    deadline: 1_900_000_000,
    slippageBps: 100,
  });
  assert.equal(params.amount0Min, 990_000n);
  assert.equal(params.amount1Min, 1_980_000n);
});

test("encodeMintCalldata targets NPM.mint and decodes to the same tuple", () => {
  const params = buildMintParams({
    token0: TOKEN,
    token1: QUOTE,
    fee: 500,
    tickLower: -120,
    tickUpper: 240,
    amount0Desired: 12_345n,
    amount1Desired: 67_890n,
    recipient: "0x3333333333333333333333333333333333333333",
    deadline: 1_900_000_000,
    slippageBps: 50,
  });
  const data = encodeMintCalldata(params);
  const iface = new Interface(NPM_ABI);
  assert.equal(data.slice(0, 10), iface.getFunction("mint").selector);

  const decoded = iface.decodeFunctionData("mint", data)[0];
  assert.equal(decoded.token0, TOKEN);
  assert.equal(decoded.token1, QUOTE);
  assert.equal(Number(decoded.fee), 500);
  assert.equal(Number(decoded.tickLower), -120);
  assert.equal(Number(decoded.tickUpper), 240);
  assert.equal(decoded.amount0Desired, 12_345n);
  assert.equal(decoded.amount1Desired, 67_890n);
  assert.equal(decoded.amount0Min, 12_283n);
  assert.equal(decoded.amount1Min, 67_550n);
  assert.equal(Number(decoded.deadline), 1_900_000_000);
});

// ─── Pool resolver ───────────────────────────────────────────────────

test("resolveDeployPool picks the deepest pool against a known quote", async () => {
  const shallow = "0x4444444444444444444444444444444444444444";
  const deep = "0x5555555555555555555555555555555555555555";
  const chainConfig = {
    tokens: {
      WETH: "0x6666666666666666666666666666666666666666",
      USDC: QUOTE,
    },
  };
  const client = {
    getPoolAddress: async ({ tokenB, fee }) => {
      if (tokenB === chainConfig.tokens.WETH && fee === 500) return deep;
      if (tokenB === chainConfig.tokens.USDC && fee === 500) return shallow;
      throw new Error("no pool");
    },
    getPoolState: async (pool) => ({
      pool,
      token0: TOKEN,
      token1: QUOTE,
      decimals0: 18,
      decimals1: 6,
      fee: 500,
      tickSpacing: 10,
      tick: 0,
      price: 1,
      liquidity: pool === deep ? "5000" : "100",
    }),
  };
  const resolved = await resolveDeployPool({ token: TOKEN, client, chainConfig });
  assert.equal(resolved.pool, deep);
  assert.equal(resolved.quoteSymbol, "WETH");
});


// ─── Automation menu / persistence / evaluation ──────────────────────

function sampleAutomation(overrides = {}) {
  return {
    id: "abc123",
    chain: "base",
    pool: "0x7777777777777777777777777777777777777777",
    tokenId: "42",
    shadow: false,
    baseSymbol: "BASE",
    quoteSymbol: "USDC",
    entryPrice: 2,
    tickLower: -120,
    tickUpper: 120,
    priceLower: 1.8,
    priceUpper: 2.2,
    baseAmount: "10",
    quoteAmount: "20",
    amountUsd: 100,
    alertIntervalMin: 15,
    takeProfitPct: 10,
    stopLossPct: -10,
    autoCloseOutOfRange: false,
    status: "open",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("management keyboard exposes every required control", () => {
  const keyboard = managementKeyboard(sampleAutomation());
  const labels = keyboard.inline_keyboard.flat().map((button) => button.text);
  assert.ok(labels.some((label) => label.includes("5m")));
  assert.ok(labels.some((label) => label.includes("15m")));
  assert.ok(labels.some((label) => label.includes("30m")));
  assert.ok(labels.some((label) => label.includes("Off")));
  assert.ok(labels.includes("Set Take Profit %"));
  assert.ok(labels.includes("Set Stop Loss %"));
  assert.ok(labels.includes("Auto-Close OOR: OFF"));
  assert.ok(labels.includes("Close Position Now"));
  for (const button of keyboard.inline_keyboard.flat()) {
    assert.ok(button.callback_data.length <= 64);
  }
});

test("automation settings persist in active-automations.json", () => {
  const filePath = tempFile();
  upsertAutomation(sampleAutomation(), { filePath });
  const store = loadAutomations(filePath);
  assert.equal(store.automations.abc123.baseSymbol, "BASE");
  assert.ok(store.updatedAt);

  upsertAutomation(sampleAutomation({ alertIntervalMin: 5 }), { filePath });
  assert.equal(loadAutomations(filePath).automations.abc123.alertIntervalMin, 5);
  const text = formatManagementCard(loadAutomations(filePath).automations.abc123);
  assert.match(text, /Alert interval:<\/b> 5m/);
  assert.match(text, /Position management/);
});

test("management callbacks update interval, TP/SL and OOR toggle", async () => {
  const filePath = tempFile();
  upsertAutomation(sampleAutomation(), { filePath });
  const ctx = {
    config: { dryRun: true, deploy: { automationsPath: filePath }, exit: {} },
    router: null,
  };

  const interval = await handleManagementCallback(ctx, "mgr:a:5:abc123");
  assert.equal(loadAutomations(filePath).automations.abc123.alertIntervalMin, 5);
  assert.match(interval.text, /Alert interval:<\/b> 5m/);

  await handleManagementCallback(ctx, "mgr:T:25:abc123");
  assert.equal(loadAutomations(filePath).automations.abc123.takeProfitPct, 25);

  await handleManagementCallback(ctx, "mgr:L:20:abc123");
  assert.equal(loadAutomations(filePath).automations.abc123.stopLossPct, -20);

  const toggled = await handleManagementCallback(ctx, "mgr:o:abc123");
  assert.equal(loadAutomations(filePath).automations.abc123.autoCloseOutOfRange, true);
  assert.match(toggled.text, /Auto-close out-of-range:<\/b> ON/);
});

test("manual close in shadow mode does not mark a live automation closed", async () => {
  const filePath = tempFile();
  upsertAutomation(sampleAutomation(), { filePath });
  const ctx = {
    config: { dryRun: true, deploy: { automationsPath: filePath }, exit: {} },
    router: null,
  };
  const reply = await handleManagementCallback(ctx, "mgr:X:abc123");
  assert.match(reply.text, /DRY-RUN: close simulated/);
  assert.equal(loadAutomations(filePath).automations.abc123.status, "open");
});

test("evaluateAutomation triggers TP, SL, OOR close and interval alerts", () => {
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  const tp = evaluateAutomation({
    automation: sampleAutomation({ takeProfitPct: 10 }),
    snapshot: { currentPrice: 2.3, inRange: true },
    now,
  });
  assert.equal(tp.close?.reason, "TAKE_PROFIT");
  assert.ok(tp.pnlPct >= 10);

  const sl = evaluateAutomation({
    automation: sampleAutomation({ stopLossPct: -10, takeProfitPct: 50 }),
    snapshot: { currentPrice: 1.7, inRange: true },
    now,
  });
  assert.equal(sl.close?.reason, "STOP_LOSS");

  const oor = evaluateAutomation({
    automation: sampleAutomation({ autoCloseOutOfRange: true, takeProfitPct: null }),
    snapshot: { currentPrice: 2, inRange: false },
    now,
  });
  assert.equal(oor.close?.reason, "OUT_OF_RANGE");

  const alert = evaluateAutomation({
    automation: sampleAutomation({
      alertIntervalMin: 5,
      lastAlertAt: "2026-10-26T11:50:00.000Z",
      takeProfitPct: null,
      stopLossPct: null,
    }),
    snapshot: { currentPrice: 2, inRange: true },
    now,
  });
  assert.equal(alert.alert, true);

  const quiet = evaluateAutomation({
    automation: sampleAutomation({
      alertIntervalMin: 0,
      takeProfitPct: null,
      stopLossPct: null,
    }),
    snapshot: { currentPrice: 2, inRange: true },
    now,
  });
  assert.equal(quiet.alert, false);
  assert.equal(quiet.close, null);
});


// ─── Plan integration with a mocked client ───────────────────────────

test("buildDeploymentPlan produces an encodable one-sided mint", async () => {
  const state = {
    pool: "0x8888888888888888888888888888888888888888",
    token0: TOKEN,
    token1: QUOTE,
    token0Symbol: "BASE",
    token1Symbol: "USDC",
    decimals0: 18,
    decimals1: 6,
    fee: 500,
    tickSpacing: 10,
    tick: 0,
    price: 2,
    liquidity: "1000000",
  };
  const allowances = new Map();
  const client = {
    config: { positionManager: NPM },
    provider: {
      estimateGas: async () => 300_000n,
      getFeeData: async () => ({ maxFeePerGas: 1_000_000n, gasPrice: 1_000_000n }),
    },
    getPoolState: async () => state,
    getTokenContract: (token) => ({
      balanceOf: async () => (String(token).toLowerCase() === TOKEN
        ? 10n * 10n ** 18n
        : 1_000n * 10n ** 6n),
      allowance: async () => allowances.get(String(token).toLowerCase()) || 0n,
    }),
  };
  const ctx = {
    config: {
      chain: "base",
      chainId: 8453,
      positionManager: NPM,
      deploy: {
        amountUsd: 100,
        minAmountUsd: 1,
        slippageBps: 100,
        deadlineSec: 1_200,
        gasLimitEstimate: 450_000,
        approveGasLimitEstimate: 60_000,
      },
      risk: {},
    },
    router: { get: () => client },
  };
  const session = {
    id: "s1",
    expiresAt: Date.now() + 60_000,
    owner: "0x3333333333333333333333333333333333333333",
    chain: "base",
    pool: state.pool,
    baseIsToken0: true,
    baseSymbol: "BASE",
    quoteSymbol: "USDC",
    baseDecimals: 18,
    quoteDecimals: 6,
    baseUsdPrice: 2,
    quoteUsdPrice: 1,
    nativeUsdPrice: 2_000,
    maxGasFeeUsd: 0.5,
    budgetUsd: 100,
    balances: { baseHuman: 10, quoteHuman: 1_000 },
    state,
  };

  const plan = await buildDeploymentPlan(ctx, session, "base", "narrow");
  assert.equal(plan.tickLower, 10);
  assert.equal(plan.tickUpper, 200);
  assert.equal(plan.baseAmount, 10);
  assert.equal(plan.quoteAmount, 0);
  assert.equal(plan.amount1Desired, 0n);
  assert.ok(plan.amount0Desired > 0n);
  assert.equal(plan.missingApprovals.length, 1);
  assert.equal(plan.missingApprovals[0].token, TOKEN);
  const decoded = new Interface(NPM_ABI).decodeFunctionData("mint", plan.calldata)[0];
  assert.equal(Number(decoded.tickLower), 10);
  assert.equal(Number(decoded.tickUpper), 200);
  assert.equal(decoded.amount1Desired, 0n);
});


// ─── Passive trigger wiring ──────────────────────────────────────────

function triggerFixture({ honeypot = false } = {}) {
  const state = {
    pool: "0x9999999999999999999999999999999999999999",
    token0: TOKEN,
    token1: QUOTE,
    token0Symbol: "BASE",
    token1Symbol: "USDC",
    decimals0: 18,
    decimals1: 6,
    fee: 500,
    tickSpacing: 10,
    tick: 0,
    price: 2,
    liquidity: "1000000",
  };
  const client = {
    config: { positionManager: NPM },
    provider: {
      getBalance: async () => 10n ** 18n,
      getFeeData: async () => ({ maxFeePerGas: 1n, gasPrice: 1n }),
    },
    getPoolAddress: async ({ tokenB, fee }) => {
      if (tokenB === QUOTE && fee === 500) return state.pool;
      throw new Error("no pool");
    },
    getPoolState: async () => state,
    getTokenMeta: async (token) => ({
      address: token,
      decimals: String(token).toLowerCase() === TOKEN ? 18 : 6,
      symbol: String(token).toLowerCase() === TOKEN ? "BASE" : "USDC",
    }),
    getTokenContract: (token) => ({
      balanceOf: async () => (String(token).toLowerCase() === TOKEN
        ? 10n * 10n ** 18n
        : 1_000n * 10n ** 6n),
      allowance: async () => 0n,
    }),
  };
  const ctx = {
    config: {
      chain: "base",
      chainId: 8453,
      chainConfig: {
        key: "base",
        name: "Base",
        chainId: 8453,
        nativeSymbol: "ETH",
        wrappedNative: "WETH",
        dexscreenerChain: "base",
        tokens: {
          WETH: "0x6666666666666666666666666666666666666666",
          USDC: QUOTE,
        },
      },
      discovery: { wallet: "0x3333333333333333333333333333333333333333" },
      deploy: {
        maxGasFeeUsd: 0.5,
        maxTaxPct: 1,
        amountUsd: 100,
        minAmountUsd: 1,
        securityTimeoutMs: 1_000,
        priceTimeoutMs: 1_000,
        gasLimitEstimate: 450_000,
        approveGasLimitEstimate: 60_000,
        nativeUsdPrice: 2_000,
      },
    },
    router: { get: () => client },
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("goplus")) {
      return {
        ok: true,
        json: async () => ({
          result: {
            [TOKEN.toLowerCase()]: {
              is_honeypot: honeypot ? "1" : "0",
              buy_tax: "0.005",
              sell_tax: "0.005",
              is_transferable: "1",
              cannot_sell_all: "0",
              is_open_source: "1",
            },
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        pairs: [{
          chainId: "base",
          priceUsd: "2",
          priceNative: "2",
          baseToken: { address: TOKEN },
          quoteToken: { address: QUOTE },
        }],
      }),
    };
  };
  return { ctx, fetchImpl, state };
}

test("startDeployment aborts honeypots before showing any menu", async () => {
  clearDeploySessions();
  const { ctx, fetchImpl } = triggerFixture({ honeypot: true });
  const reply = await startDeployment(ctx, [TOKEN], { fetchImpl });
  assert.match(reply.text, /Deployment aborted/);
  assert.match(reply.text, /Honeypot/);
  assert.equal(reply.replyMarkup, null);
});

test("startDeployment opens Step 1 only after passing guardrails", async () => {
  clearDeploySessions();
  const { ctx, fetchImpl } = triggerFixture();
  const reply = await startDeployment(ctx, [TOKEN], { fetchImpl });
  assert.match(reply.text, /Deploy pre-flight/);
  assert.match(reply.text, /Guardrails/);
  const labels = reply.replyMarkup.inline_keyboard.flat().map((button) => button.text);
  assert.ok(labels.includes("Single-Side Base"));
  assert.ok(labels.includes("Single-Side Quote"));
  assert.ok(labels.includes("Dual 50:50"));
  clearDeploySessions();
});


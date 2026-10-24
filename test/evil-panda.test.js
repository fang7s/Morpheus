import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateBollingerBands,
  calculateRSI,
  checkEvilPandaExitConfluence,
  createExitConfirmation,
} from "../tools/evil-panda.js";
import {
  getAmountsForLiquidity,
  nearestUsableTick,
  priceToTick,
  sqrtPriceX96ToPrice,
  tickToPrice,
} from "../tools/uniswap-v3.js";

const Q96 = 2n ** 96n;

function rallyPrices() {
  const prices = [];
  for (let i = 0; i < 40; i++) prices.push(100 + Math.sin(i) * 0.05);
  prices.push(103, 106, 109);
  return prices;
}

test("RSI(2) is neutral for a flat window and 100 for a pure rally", () => {
  assert.equal(calculateRSI(new Array(10).fill(100), 2), 50);
  assert.equal(calculateRSI([1, 2, 3, 4, 5], 2), 100);
});

test("Bollinger Bands expose a positive upper band on a rally", () => {
  const bb = calculateBollingerBands(rallyPrices(), 20, 2);
  assert.ok(bb);
  assert.ok(bb.stdDeviation > 0);
  assert.ok(bb.upperBand > bb.sma);
  assert.ok(bb.lowerBand < bb.sma);
});

test("Evil Panda confluence exits on RSI + BB penetration + positive MACD", () => {
  const prices = rallyPrices();
  const result = checkEvilPandaExitConfluence(prices, prices.at(-1), {
    rsiOverbought: 80,
    minCandles: 35,
  });
  assert.equal(result.shouldExit, true);
  assert.ok(result.rsi >= 80);
  assert.equal(result.bbTriggered, true);
  assert.equal(result.macdTriggered, true);
  assert.match(result.reason, /EXIT CONFLUENCE HIT/);
});

test("Evil Panda does not exit on a flat series", () => {
  const prices = new Array(60).fill(1);
  const result = checkEvilPandaExitConfluence(prices, 1, { rsiOverbought: 80 });
  assert.equal(result.shouldExit, false);
  assert.equal(result.rsi, 50);
});

test("3-tick confirmation fires only on the third consecutive identical signal", () => {
  const poller = createExitConfirmation(3);
  assert.equal(poller.confirm("pool", "EVIL_PANDA").fire, false);
  assert.equal(poller.confirm("pool", "EVIL_PANDA").fire, false);
  const third = poller.confirm("pool", "EVIL_PANDA");
  assert.equal(third.fire, true);
  assert.equal(third.count, 3);
});

test("confirmation streak resets when the signal clears", () => {
  const poller = createExitConfirmation(3);
  poller.confirm("pool", "EVIL_PANDA");
  poller.confirm("pool", "EVIL_PANDA");
  assert.equal(poller.confirm("pool", null).count, 0);
  assert.equal(poller.confirm("pool", "EVIL_PANDA").count, 1);
});

test("sqrtPriceX96 and tick conversions agree for equal-decimal tokens", () => {
  assert.ok(Math.abs(sqrtPriceX96ToPrice(2n * Q96, 18, 18) - 4) < 1e-9);
  assert.ok(Math.abs(tickToPrice(0, 18, 18) - 1) < 1e-12);
  assert.ok(Math.abs(priceToTick(1, 18, 18)) < 1e-9);
});

test("tick rounding and liquidity amounts are sane", () => {
  assert.equal(nearestUsableTick(103, 10), 100);
  const amounts = getAmountsForLiquidity(Q96, -600, 600, 10n ** 18n);
  assert.ok(amounts.amount0 >= 0n);
  assert.ok(amounts.amount1 >= 0n);
  assert.ok(amounts.amount0 > 0n && amounts.amount1 > 0n);
});

test("liquidity is fully in token1 when price is above the range", () => {
  const amounts = getAmountsForLiquidity(10n * Q96, -600, 600, 10n ** 18n);
  assert.equal(amounts.amount0, 0n);
  assert.ok(amounts.amount1 > 0n);
});

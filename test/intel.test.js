import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { encodeAbiParameters, getAddress } from "viem";

import {
  DEFAULT_TOKEN,
  ROBINHOOD_CHAIN_ID,
  SENSITIVE_SELECTORS,
  analyzeTokenOnChain,
  assessRisk,
  classifyOwner,
  decodeStringResult,
  fetchDefiLlamaPrice,
  parseArgs,
  scanBytecode,
} from "../src/intel/index.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const COIN_KEY = `robinhood:${TOKEN}`;

const RENOUNCED = {
  status: "renounced",
  owner: "0x0000000000000000000000000000000000000000",
  ownerType: null,
  note: "renounced",
};

const ACTIVE = {
  status: "active",
  owner: "0x0000000000000000000000000000000000000001",
  ownerType: "eoa",
  note: "active",
};

const NO_PROXY = {
  isProxy: false,
  implementation: null,
  implementationScan: null,
  note: "no proxy",
};

const PROXY = {
  isProxy: true,
  implementation: "0x0000000000000000000000000000000000000002",
  implementationScan: null,
  note: "proxy",
};

function dispatcherCode(selectors) {
  return `0x6080604052${selectors.map((selector) => `63${selector}14`).join("")}00`;
}

async function startServer(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

test("intel public barrel exposes the library API", () => {
  assert.equal(typeof analyzeTokenOnChain, "function");
  assert.equal(typeof fetchDefiLlamaPrice, "function");
  assert.equal(ROBINHOOD_CHAIN_ID, 4663);
  assert.equal(DEFAULT_TOKEN, "0xa2b38467e9b60c016d94977ad37f825da4cd3462");
});

test("intel CLI defaults to ASSAY", () => {
  const options = parseArgs([], {}, false);
  assert.equal(options.address.toLowerCase(), DEFAULT_TOKEN);
  assert.equal(options.timeoutMs, 10_000);
  assert.equal(options.json, false);
});

test("intel bytecode scan finds dispatcher selectors", () => {
  const selectors = SENSITIVE_SELECTORS.map((entry) => entry.selector.slice(2));
  const scan = scanBytecode(dispatcherCode(selectors));

  assert.equal(scan.isContract, true);
  assert.equal(scan.detected.length, selectors.length);
  assert.equal(scan.highRisk.length, 4);

  const mint = scan.selectors.find((entry) => entry.selector === "0x40c10f19");
  assert.equal(mint.dispatch, "push4-dispatch");
  assert.equal(mint.push4Matches, 1);

  const clean = scanBytecode("0x6080604052348015600f57600080fd5b50");
  assert.equal(clean.detected.length, 0);
});

test("intel bytecode scan labels non-dispatcher matches as embedded", () => {
  const scan = scanBytecode(
    "0x7f40c10f1900000000000000000000000000000000000000000000000000000000",
  );
  const probe = scan.selectors.find((entry) => entry.selector === "0x40c10f19");

  assert.equal(probe.detected, true);
  assert.equal(probe.dispatch, "embedded-bytes");
  assert.equal(probe.push4Matches, 0);
  assert.equal(probe.byteMatches, 1);
});

test("intel metadata decoder handles strings and bytes32", () => {
  const encoded = encodeAbiParameters([{ type: "string" }], ["Assay Labs"]);
  assert.equal(decodeStringResult(encoded), "Assay Labs");

  const bytes32 = `0x${Buffer.from("ASSAY").toString("hex").padEnd(64, "0")}`;
  assert.equal(decodeStringResult(bytes32), "ASSAY");
  assert.equal(decodeStringResult("0x"), null);
});

test("intel owner classification separates renounced and active", () => {
  assert.equal(classifyOwner(`0x${"0".repeat(64)}`).status, "renounced");

  const ownerWord = `0x${"0".repeat(24)}${"ab".repeat(20)}`;
  const active = classifyOwner(ownerWord);
  assert.equal(active.status, "active");
  assert.equal(active.owner, getAddress(`0x${"ab".repeat(20)}`));

  assert.equal(classifyOwner("0x").status, "not_exposed");
});

test("intel risk heuristic escalates high-risk selectors", () => {
  const cleanScan = scanBytecode("0x6080604052348015600f57600080fd5b50");
  const mintScan = scanBytecode(dispatcherCode(["40c10f19"]));

  assert.equal(
    assessRisk({ isContract: true, ownership: RENOUNCED, scan: cleanScan, proxy: NO_PROXY }).level,
    "low",
  );
  assert.equal(
    assessRisk({ isContract: true, ownership: ACTIVE, scan: cleanScan, proxy: NO_PROXY }).level,
    "medium",
  );
  assert.equal(
    assessRisk({ isContract: true, ownership: RENOUNCED, scan: cleanScan, proxy: PROXY }).level,
    "medium",
  );
  assert.equal(
    assessRisk({ isContract: true, ownership: RENOUNCED, scan: mintScan, proxy: NO_PROXY }).level,
    "high",
  );
});

test("intel DeFiLlama client reads price, confidence and 24h change", async () => {
  const server = await startServer((req, res) => {
    if (req.url?.startsWith("/prices/current/")) {
      sendJson(res, 200, {
        coins: {
          [COIN_KEY]: {
            decimals: 18,
            symbol: "TEST",
            price: 1.25,
            timestamp: 1_700_000_000,
            confidence: 0.97,
          },
        },
      });
      return;
    }
    if (req.url?.startsWith("/percentage/")) {
      sendJson(res, 200, { coins: { [COIN_KEY]: -2.25 } });
      return;
    }
    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    const result = await fetchDefiLlamaPrice(TOKEN, {
      baseUrl: server.url,
      timeoutMs: 2_000,
    });

    assert.equal(result.found, true);
    assert.equal(result.symbol, "TEST");
    assert.equal(result.decimals, 18);
    assert.equal(result.priceUsd, 1.25);
    assert.equal(result.change24hPct, -2.25);
    assert.equal(result.change24hSource, "percentage");
    assert.equal(result.confidence, 0.97);
    assert.equal(result.error, null);
  } finally {
    await server.close();
  }
});

test("intel DeFiLlama client reports not-indexed tokens gracefully", async () => {
  const server = await startServer((_req, res) => sendJson(res, 200, { coins: {} }));

  try {
    const result = await fetchDefiLlamaPrice(TOKEN, {
      baseUrl: server.url,
      timeoutMs: 2_000,
    });

    assert.equal(result.found, false);
    assert.equal(result.priceUsd, null);
    assert.match(result.error ?? "", /not indexed/i);
  } finally {
    await server.close();
  }
});

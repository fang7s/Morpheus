import test from "node:test";
import assert from "node:assert/strict";

import { clearDiscoveryCache } from "../tools/discovery.js";
import { positionKey } from "../tools/position-key.js";
import {
  BOT_COMMANDS,
  chunkMessage,
  escapeHtml,
  formatHelp,
  formatHistory,
  formatPnl,
  formatPositions,
  formatWallet,
  handleTelegramCommand,
  isAuthorizedChat,
  parseTelegramCommand,
  sendTelegramMessage,
  startTelegramCommandPoller,
} from "../tools/telegram-commands.js";

const WALLET = "0x1111111111111111111111111111111111111111";

function baseConfig(overrides = {}) {
  return {
    dryRun: true,
    chain: "base",
    chainId: 8453,
    privateKey: null,
    discovery: { wallet: WALLET },
    rpcByChain: { base: ["https://base.example"] },
    telegram: {
      enabled: false,
      commandsEnabled: true,
      botToken: "123:test-token",
      chatId: "42",
    },
    ...overrides,
  };
}

function samplePosition() {
  return {
    label: "WETH/USDC shadow",
    chain: "base",
    chainId: 8453,
    pool: "0x2222222222222222222222222222222222222222",
    token0: "0x3333333333333333333333333333333333333333",
    token1: "0x4444444444444444444444444444444444444444",
    state: { token0Symbol: "WETH", token1Symbol: "USDC" },
    onchain: { tickLower: -120, tickUpper: 120 },
    fee: 100,
    tokenId: "777",
    amountUsd: 1000,
  };
}

function sampleRuntime(position) {
  return {
    startedAtMs: Date.now() - 65_000,
    polls: 4,
    errors: 1,
    tracked: new Map([[
      positionKey(position),
      {
        exited: false,
        entryPrice: 2000,
        entryAt: "2026-10-25T00:00:00.000Z",
        last: { price: 2100, source: "geckoterminal", at: "2026-10-25T01:00:00.000Z" },
      },
    ]]),
    exits: [
      {
        label: "old",
        chain: "ethereum",
        at: "2026-10-24T00:00:00.000Z",
        reason: "EVIL_PANDA",
        entryPrice: 1900,
        exitPrice: 1850,
        amountUsd: 1000,
        pnlUsd: -26.315,
        shadow: true,
      },
      {
        label: "WETH/USDC",
        chain: "base",
        at: "2026-10-25T00:00:00.000Z",
        reason: "EVIL_PANDA",
        entryPrice: 2000,
        exitPrice: 2100,
        amountUsd: 1000,
        pnlUsd: 50,
        shadow: true,
      },
      {
        label: "unpriced",
        chain: "bnb",
        at: "2026-10-25T00:30:00.000Z",
        reason: "EVIL_PANDA",
        exitPrice: 1,
        amountUsd: null,
        pnlUsd: null,
        shadow: false,
      },
    ],
  };
}

test("registers the expected Telegram command menu", () => {
  const commands = BOT_COMMANDS.map((entry) => entry.command);
  for (const expected of ["start", "help", "wallet", "positions", "history", "pnl"]) {
    assert.ok(commands.includes(expected), `missing /${expected}`);
  }
});

test("parses commands with bot suffix and ignores plain text", () => {
  assert.equal(parseTelegramCommand("/positions@MorpheusBot now"), "positions");
  assert.equal(parseTelegramCommand("  /PNL  "), "pnl");
  assert.equal(parseTelegramCommand("hello /help"), null);
  assert.equal(parseTelegramCommand("/"), null);
});

test("authorizes only the exact configured chat ID", () => {
  assert.equal(isAuthorizedChat(42, "42"), true);
  assert.equal(isAuthorizedChat("42", " 42 "), true);
  assert.equal(isAuthorizedChat("43", "42"), false);
  assert.equal(isAuthorizedChat(42, ""), false);
  assert.equal(isAuthorizedChat(undefined, "42"), false);
});

test("chunks long Telegram replies below the message limit", () => {
  const chunks = chunkMessage("line\n".repeat(2_000), 1_000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 1_000);
});

test("help text includes status and every command", () => {
  const text = formatHelp(baseConfig(), { startedAtMs: Date.now() - 60_000, polls: 2, errors: 0 });
  assert.match(text, /Morpheus EVM LP Agent/);
  assert.match(text, /SHADOW \/ DRY-RUN/);
  assert.match(text, /Chain: <code>base<\/code>/);
  assert.match(text, /\/wallet/);
  assert.match(text, /\/positions/);
  assert.match(text, /\/history/);
  assert.match(text, /\/pnl/);
});

test("positions show pair, chain, entry, active, ticks and skip closed", () => {
  const position = samplePosition();
  const runtime = sampleRuntime(position);
  const closed = { ...samplePosition(), label: "closed", pool: `0x${"9".repeat(40)}` };
  runtime.tracked.set(positionKey(closed), { exited: true });

  const text = formatPositions([position, closed], runtime);
  assert.match(text, /Open LP positions \(1\)/);
  assert.match(text, /WETH\/USDC \[base\]/);
  assert.match(text, /fee 100 \| ticks -120 → 120/);
  assert.match(text, /entry \$2,000\.00 \| active \$2,100\.00 \| delta \+5\.00%/);
  assert.doesNotMatch(text, /\[closed\]/);
});

test("history returns the newest closed positions and close reasons", () => {
  const text = formatHistory(sampleRuntime(samplePosition()), 2);
  assert.match(text, /Closed LP positions \(last 2\)/);
  assert.match(text, /unpriced \[bnb\]/);
  assert.match(text, /WETH\/USDC \[base\]/);
  assert.match(text, /reason: EVIL_PANDA/);
  assert.doesNotMatch(text, /old \[ethereum\]/);
});

test("PnL summarizes estimated wins, losses and unestimated exits", () => {
  const text = formatPnl(sampleRuntime(samplePosition()));
  assert.match(text, /Closed trades: 3/);
  assert.match(text, /Estimated PnL: \+\$23\.69/);
  assert.match(text, /Wins: 1 \| Losses: 1 \| Unestimated: 1/);
});

test("wallet reports address, native balances and per-chain status", async () => {
  const router = {
    get: () => ({
      provider: {
        getBlockNumber: async () => 123,
        getBalance: async () => 10n ** 18n,
      },
    }),
  };
  const config = baseConfig({
    rpcByChain: { base: ["https://base.example"], bnb: ["https://bsc.example"] },
  });
  const text = await formatWallet({ config, router });
  assert.match(text, new RegExp(`Address: ${WALLET}`));
  assert.match(text, /Base: OK \(block 123\) \| 1\.000000 ETH/);
  assert.match(text, /BNB Smart Chain: OK \(block 123\) \| 1\.000000 BNB/);
});

test("sendTelegramMessage splits long replies and targets the configured chat", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendTelegramMessage(baseConfig(), "x".repeat(5_000), fetchImpl);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.chat_id, "42");
    assert.equal(call.parse_mode, "HTML");
    assert.ok(call.text.length <= 3_900);
  }
});

test("HTML parse errors retry as plain text instead of failing silently", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) {
      return {
        ok: false,
        json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await sendTelegramMessage(baseConfig(), "<b>status</b>", fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parse_mode, "HTML");
  assert.equal(calls[1].parse_mode, undefined);
});

test("poller ignores unauthorized chats and stops cleanly", async () => {
  const sent = [];
  let calls = 0;
  const fetchImpl = async (_url, { signal }) => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            { update_id: 1, message: { chat: { id: 99 }, text: "/pnl" } },
            { update_id: 2, message: { chat: { id: 42 }, text: "/help" } },
          ],
        }),
      };
    }
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };

  const ctx = {
    config: baseConfig(),
    positions: [],
    runtime: { exits: [], tracked: new Map(), polls: 0, errors: 0 },
  };
  const poller = startTelegramCommandPoller(ctx, {
    fetchImpl,
    send: async (text) => { sent.push(text); },
    pollIntervalMs: 1,
    retryDelayMs: 1,
    timeoutSec: 1,
    registerCommands: false,
  });
  assert.ok(poller);

  const deadline = Date.now() + 2_000;
  while (sent.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(sent.length, 1);
  assert.match(sent[0], /Morpheus EVM LP Agent/);
  assert.doesNotMatch(sent[0], /Realized PnL/);

  poller.stop();
  poller.stop();
  await poller.done;
  assert.equal(poller.stopped, true);
});

test("positions command merges on-demand wallet discovery", async () => {
  clearDiscoveryCache();
  const discovered = {
    label: "wallet-9",
    chain: "bnb",
    chainId: 56,
    pool: "0x5555555555555555555555555555555555555555",
    token0: "0x6666666666666666666666666666666666666666",
    token1: "0x7777777777777777777777777777777777777777",
    state: { token0Symbol: "WBNB", token1Symbol: "USDT" },
    onchain: { tickLower: -60, tickUpper: 60 },
    fee: 100,
    tokenId: "9",
  };
  const ctx = {
    config: {
      ...baseConfig({
        discovery: { enabled: true, wallet: WALLET, maxPositions: 5 },
        rpcByChain: { bnb: ["https://bsc.example"] },
      }),
    },
    router: {
      get: () => ({
        getWalletPositions: async () => [{
          tokenId: discovered.tokenId,
          pool: discovered.pool,
          token0: discovered.token0,
          token1: discovered.token1,
          token0Symbol: "WBNB",
          token1Symbol: "USDT",
          fee: discovered.fee,
          tickLower: -60,
          tickUpper: 60,
        }],
        resolveBaseToken: async () => discovered.token1,
      }),
    },
    positions: [],
    runtime: { tracked: new Map(), exits: [] },
  };

  const text = await handleTelegramCommand("positions", ctx);
  assert.match(text, /WBNB\/USDT \[bnb\]/);
  assert.match(text, /Wallet discovery: 1 position\(s\)/);
  assert.match(text, /ticks -60 → 60/);
});

test("HTML replies escape dynamic values", () => {
  assert.equal(escapeHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
});

test("wallet command lists discovered LP positions", async () => {
  clearDiscoveryCache();
  const router = {
    get: () => ({
      provider: {
        getBlockNumber: async () => 1,
        getBalance: async () => 0n,
      },
      getWalletPositions: async () => [{
        tokenId: "3",
        pool: "0x8888888888888888888888888888888888888888",
        token0: "0x9999999999999999999999999999999999999999",
        token1: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token0Symbol: "WETH",
        token1Symbol: "USDC",
        fee: 500,
      }],
      resolveBaseToken: async () => "0x9999999999999999999999999999999999999999",
    }),
  };
  const config = baseConfig({
    discovery: { enabled: true, wallet: WALLET, maxPositions: 5 },
  });
  const text = await formatWallet({ config, router });
  assert.match(text, /Discovered LP positions:<\/b> 1/);
  assert.match(text, /WETH\/USDC \[base\]/);
});

test("poller stays disabled without credentials or when commands are off", () => {
  const noCredentials = {
    config: baseConfig({ telegram: { commandsEnabled: true, botToken: "", chatId: "42" } }),
    positions: [],
    runtime: {},
  };
  assert.equal(startTelegramCommandPoller(noCredentials), null);

  const disabled = {
    config: baseConfig({ telegram: { commandsEnabled: false, botToken: "t", chatId: "42" } }),
    positions: [],
    runtime: {},
  };
  assert.equal(startTelegramCommandPoller(disabled), null);
});


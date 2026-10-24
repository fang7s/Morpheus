# Prometheus EVM

A shadow-first concentrated-liquidity LP bot for **Uniswap v3 on Arbitrum, Base,
Ethereum Mainnet, BNB Smart Chain and Robinhood Chain**. It ports the Evil Panda
indicator exit engine from `prometheus solana/tools/evil-panda-enhanced.js` and
replaces the Solana/DLMM layers with an ethers v6 Uniswap v3 stack.

> **Not audited. Use at your own risk.** Shadow mode is enabled by default and
> never signs a transaction.

---

## Safety model

| Mode | Requirements | Behaviour |
| --- | --- | --- |
| Shadow / dry-run (default) | none | Reads prices/positions, logs exit decisions, sends no transactions |
| Live | `DRY_RUN=false`, `I_UNDERSTAND_LIVE_TRADING=true`, `PRIVATE_KEY` | Removes liquidity, collects principal + fees, optionally burns the NFT |

Any live request missing the acknowledgement is automatically forced back into
shadow mode. Positions without a `tokenId` are always watch-only.

---

## Layout

```
prometheus-evm/
├── package.json
├── .env.example
├── user-config.example.json
├── config.js                  # chain registry, validation, env/user-config merge
├── logger.js                  # local file + console logger
├── index.js                   # entry point, poller, health endpoint, shadow/live exit
├── tools/
│   ├── evil-panda.js          # RSI/BB/MACD, confluence exit, price pipeline, 3-tick poller
│   └── uniswap-v3.js          # ethers v6 slot0 reader, tick/liquidity math, NPM read/close/mint
└── test/
    └── evil-panda.test.js     # indicator, confirmation and math tests
```


---

## Quick start

```powershell
cd prometheus-evm
npm install

Copy-Item .env.example .env
Copy-Item user-config.example.json user-config.json

npm run check      # validate config, prints a summary, no RPC calls
npm run once       # one evaluation cycle, then exit
npm start          # continuous poller (also shadow mode unless configured otherwise)
```

Node.js >= 18 is required (uses built-in `fetch` and `node:test`).

---

## Supported chains

| Key | Network | Chain ID | Wrapped native | Gecko / DexScreener | RPC presets (priority order) |
| --- | --- | --- | --- | --- | --- |
| `arbitrum` | Arbitrum One | 42161 | WETH | `arbitrum` / `arbitrum` | arb1.arbitrum.io, arbitrum-rpc.publicnode.com |
| `base` | Base | 8453 | WETH | `base` / `base` | mainnet.base.org, base-rpc.publicnode.com, base.llamarpc.com |
| `ethereum` | Ethereum Mainnet | 1 | WETH | `eth` / `ethereum` | ethereum-rpc.publicnode.com, eth.llamarpc.com, cloudflare-eth.com |
| `bnb` | BNB Smart Chain | 56 | WBNB | `bsc` / `bsc` | bsc-rpc.publicnode.com, bsc-dataseed.binance.org, bsc-dataseed1.defibit.io |
| `robinhood` | Robinhood Chain (Arbitrum Orbit) | 4663 | WETH | `robinhood` / `robinhood` | rpc.mainnet.chain.robinhood.com, robinhood-rpc.publicnode.com, robinhood.drpc.org |

Aliases accepted by `--chain` / `CHAIN`: `eth`, `mainnet` (Ethereum), `bsc`,
`binance` (BNB), `orbit`, `robinhood-chain` (Robinhood).

When more than one RPC preset is available, `tools/uniswap-v3.js` builds an
ethers `FallbackProvider` with `quorum: 1`, so a failing or stalled endpoint
fails over to the next preset for pool resolution and `slot0` reads. `RPC_URL`
in `.env` always takes highest priority; `rpcUrl`/`rpcUrls` in
`user-config.json` override the chain defaults.

Verified Uniswap v3 deployments:

| Chain | Factory | NonfungiblePositionManager | QuoterV2 |
| --- | --- | --- | --- |
| Ethereum | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| BNB Chain | `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7` | `0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613` | `0x78D78E420Da98ad378D7799bE8f4AF69033EB077` |
| Robinhood | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |

Robinhood Chain token addresses: WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`,
USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, cbBTC
`0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4`, W0G
`0x32003CC8357938bCF615c1222a349c58f2B30698`.

---

## Configuration

Environment variables (`.env`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHAIN` | `arbitrum` | `arbitrum` or `base` |
| `RPC_URL` | public chain RPC | JSON-RPC endpoint; use a private provider in production |
| `POLL_INTERVAL_MS` | `15000` | Evaluation cadence (minimum 3000) |
| `DRY_RUN` | `true` | `false` requests live mode |
| `I_UNDERSTAND_LIVE_TRADING` | `false` | Must be `true` for live mode |
| `PRIVATE_KEY` | empty | Hot wallet key, live only |
| `HEALTH_ENABLED` / `HEALTH_PORT` | `false` / `3010` | Optional HTTP status endpoint |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | empty | Optional Telegram alerts |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

`user-config.json` is optional and merged over the defaults. See
`user-config.example.json` for a complete example.

### Positions

A position can be defined three ways:

```jsonc
// 1) Watch a pool resolved from tokens + fee tier (no tokenId = shadow only)
{ "label": "WETH/USDC 5bp", "token0": "WETH", "token1": "USDC", "baseToken": "WETH", "fee": 500 }

// 2) Watch an explicit pool address (no tokenId = shadow only)
{ "label": "custom pool", "pool": "0x...", "baseToken": "0x..." }

// 3) Manage a real NPM position (live mode closes it)
{ "label": "my LP", "tokenId": "123456", "baseToken": "WETH" }
```

`token0`, `token1`, and `baseToken` accept either symbols from the chain registry
(`WETH`, `USDC`, `USDT`, `DAI`, `WBTC`, plus `cbBTC` on Base) or raw addresses.
`baseToken` controls the price orientation used by the indicators.

Wallet discovery is available with:

```json
"discovery": { "enabled": true, "wallet": "0xYourWallet", "maxPositions": 10 }
```

### Evil Panda settings

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Run the indicator exit engine |
| `timeframe` | `"5m"` | Gecko candle aggregation (`5m`, `15m`, `1h`, …) |
| `candles` | `120` | Requested candle count |
| `cacheSec` | `60` | Price-series cache TTL |
| `confirmTicks` | `3` | Consecutive confirming polls required to exit |
| `rsiPeriod` | `2` | RSI lookback |
| `rsiOverbought` | `80` | RSI trigger, documented 70-80 band |
| `bbPeriod` / `bbStdDev` | `20` / `2` | Bollinger Band settings |
| `macdFast/Slow/Signal` | `12/26/9` | MACD settings |
| `confluenceMode` | `"any"` | `any` = RSI AND (BB OR MACD); `all` = RSI AND BB AND MACD |
| `requireMacdShift` | `false` | `true` requires a fresh negative→positive histogram cross |
| `minCandles` | `35` | Minimum samples before indicators run |

> The reference Solana implementation used `RSI > 90`. This port defaults to the
> requested 80 (top of the 70-80 band); the trigger is configurable.

---

## Exit engine

1. **RSI(2) overbought** — `RSI >= rsiOverbought` (default 80).
2. **Upper Bollinger penetration** — current price `>= upperBand` with non-zero σ.
3. **MACD shift** — histogram `> 0`; optionally require the histogram to cross
   from `<= 0` to `> 0` with `requireMacdShift: true`.
4. **Confluence** — `RSI AND (BB OR MACD)` by default.
5. **3-tick confirmation** — the same signal must be observed on
   `confirmTicks` consecutive polls. Any clear or change in signal resets the streak.

When confirmed, shadow mode logs `SHADOW exit` with the reason and price source;
live mode calls `decreaseLiquidity → collect → burn` through the Nonfungible
Position Manager.

---

## Price pipeline

For each pool, `tools/evil-panda.js` tries:

1. **GeckoTerminal OHLCV** — `/networks/{arbitrum|base|eth|bsc|robinhood}/pools/{pool}/ohlcv/...`
2. **DexScreener spot** — pool endpoint, then token endpoint. Prices are
   normalized to the USD price of the configured `baseToken`.
3. **Uniswap v3 `slot0`** — active tick price read on-chain, oriented to the base token.
4. **In-memory buffer** — up to 50 timestamped spot samples with a 30-minute age
   cap. Used to synthesize candles when OHLCV is unavailable.

GeckoTerminal always reports candles in USD of the **pool's chosen base token**,
which is not necessarily your token. For example, Gecko lists
`USDC/WETH 0.05%` with USDC as base, so its candles are ~$1.00 USDC, not WETH.
The bot detects this mismatch and rejects the Gecko series rather than feeding a
wrong/inverted series into RSI, BB, or MACD. In that situation DexScreener/slot0
fills the in-memory buffer, so the engine needs `minCandles` samples before it can
evaluate (about 9 minutes at the default 15s poll). Buffer sources reset whenever
the price unit changes so USD and quote-denominated samples never mix.

---

## Health endpoint

When `health.enabled` is true:

- `GET /health` — mode, chain, uptime, poll count, exits, errors, buffer stats
- `GET /positions` — configured positions plus their latest signal state

---

## Tests

```powershell
npm test            # syntax checks + unit tests
npm run test:unit   # indicators, confluence, confirmation, tick/liquidity math
node --check tools/evil-panda.js
```

---

## Notes and limitations

- The close path uses `amount0Min`/`amount1Min` derived from current pool math and
  the configured `slippageBps`; adjust it for volatile pairs.
- `risk.stopLossPct` / `risk.takeProfitPct` are reserved metadata; only the Evil
  Panda exit is wired to execution.
- Public RPC endpoints rate-limit. Use a dedicated provider for your chain
  (set `RPC_URL`) for continuous operation.
- This bot manages exits; minting/increase helpers exist in `tools/uniswap-v3.js`
  but are not part of the default entry point.



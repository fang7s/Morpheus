# Morpheus EVM LP Agent 🌊

Autonomous Concentrated Liquidity LP Manager for EVM chains (Ethereum, BNB Chain,
Base, Robinhood Chain) on Uniswap v3 & PancakeSwap v3.

## Key Features

- **Multi-Chain Dynamic RPC Auto-Routing** — define every chain's RPCs in `.env`
  at once. Each LP position is inspected, its chain/chain ID is resolved, and
  queries are routed to that chain's dedicated provider.
- **FallbackProvider** — comma-separated `*_RPC_URLS` lists are deduplicated and
  wrapped in an ethers `FallbackProvider` (`quorum: 1`) for automatic failover.
- **Evil Panda Exit Engine** — RSI(2), Bollinger Band penetration and MACD
  confluence with a 3-tick confirmation poller.
- **Multi-Layer Pricing Pipeline** — GeckoTerminal OHLCV → DexScreener spot →
  Uniswap v3 `slot0` → in-memory price buffer.

## Quick Start

```powershell
npm install
Copy-Item .env.example .env
npm run check
npm start
```

At inspection time Morpheus resolves the position's target chain and chain ID,
then lazily creates a client bound to that chain's `.env` RPC route. Positions
without `chain`/`chainId` inherit `CHAIN`.

Wallet LP auto-discovery is enabled by default (`DISCOVERY_ENABLED=true`). If
`user-config.json` contains no positions, Morpheus scans every configured chain
for NFT positions owned by the discovery wallet (or the address derived from
`WALLET_PRIVATE_KEY`). `/positions` and `/wallet` refresh this discovery on
demand, so an empty config no longer blocks startup.

## Telegram Command Menu

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`, then start the bot.
The menu uses non-blocking long polling and accepts commands only from the
configured chat ID.

| Command | Description |
| --- | --- |
| `/start`, `/help` | Command list and bot status |
| `/wallet` | Wallet address, native ETH/BNB balances, per-chain RPC status, discovered LP count |
| `/positions` | Open LP positions, chain, pool/ticks, entry and active price; refreshes wallet discovery |
| `/deploy <token_address>` | User-triggered LP deployment with pre-flight guardrails and inline side/range/confirm menus |
| `/pool <address>` | Multi-chain token/pool analysis: auto-detects TOKEN vs POOL, resolves all pools, top-3 TVL detail, GoPlus safety and risk narrative |
| `/history` | Last 10 closed positions with timestamp and close reason |
| `/pnl` | Closed-trade count and estimated realized PnL |

`/pool` auto-detects whether the input is a TOKEN or a POOL contract (via
DexScreener/GeckoTerminal and on-chain `token0()`/`token1()`/`decimals()`
reads). Token inputs query GoPlus with the token address and aggregate every
pool where the token is `token0` or `token1`; pool inputs resolve both
underlying tokens and fetch security for each. Pools are normalized to strict
20-byte EVM addresses, fees are read from `fee()` when APIs omit them, and only
the top 3 pools by TVL are detailed. Missing GoPlus metadata is reported as
`UNVERIFIED (MEDIUM)`, never `LOW`.

`/pool` discovers tokens and pools on Arbitrum, Base, BNB Chain, Ethereum,
Polygon, Avalanche, Optimism and Robinhood Chain through DexScreener,
GeckoTerminal, GoPlus and on-chain fee reads.

Fee tiers are resolved in this order: DexScreener/GeckoTerminal -> secondary
indexer/subgraph -> on-chain `fee()` RPC. When an aggregator returns `fee n/a`
(for example on Robinhood Chain 4663), set `INDEXER_API_URL` or a chain-scoped
`SUBGRAPH_URL_<chainId>` (such as `SUBGRAPH_URL_4663`) to query the Uniswap v3
`Pool` entity for the exact `feeTier` and `tickSpacing`. GraphQL subgraphs,
Envio and Defined.fi-style REST endpoints are supported (`INDEXER_API_TYPE`).
The resolved tier is shown directly in the report, e.g.
`SEASON/ETH — Uniswap v3 (0.05%)`.

`TELEGRAM_ENABLED` controls exit/alert notifications independently.
`TELEGRAM_COMMANDS_ENABLED=false` disables the command menu.

## User-Triggered `/deploy`

The bot is never allowed to scan and buy on its own. A deployment starts only
when the authorized chat sends `/deploy <token_address>`.

**Pre-flight guardrails (run before any menu is shown):**

1. **Token safety** — GoPlus is queried for honeypot, transferability and
   buy/sell tax. The flow aborts on a honeypot, disabled transfers, a
   `cannot_sell_all` flag, or tax above `DEPLOY_MAX_TAX_PCT` (default `1%`).
   Missing safety data fails closed unless `DEPLOY_ALLOW_UNVERIFIED=true`.
2. **Gas ceiling** — the RPC fee data plus a conservative mint/approve gas
   estimate is converted to USD using DexScreener native pricing (or
   `NATIVE_USD_PRICE`). The flow aborts above `MAX_GAS_FEE_USD` (default
   `$0.50`) and checks the native balance can cover the fee.
3. **Pool, balance & allowance** — the deepest Uniswap v3 pool against a known
   quote token is resolved on-chain, balances are read, and the exact ERC20
   allowance for the NonfungiblePositionManager is inspected. Missing approvals
   are sent automatically only after the user confirms the mint.

**Inline menu:**

1. Side: `Single-Side Base` · `Single-Side Quote` · `Dual 50:50`
2. Range: `Narrow ±2%` · `Moderate ±5%` · `Wide ±15%`
3. Confirmation card with estimated deposits, lower/upper prices and ticks,
   approvals, gas cost and a `🚀 Confirm & Mint` button. Confirmation signs and
   broadcasts `mint()` with `WALLET_PRIVATE_KEY` (live mode only).

Single-side ranges are anchored above/below spot so only the selected token is
deposited. The USD budget comes from `DEPLOY_AMOUNT_USD` (default `$100`) and is
capped by wallet balances.

**Post-deployment management:**

After minting, the management card exposes alert interval (`5m` / `15m` / `30m`
/ `Off`), take-profit and stop-loss presets, an auto-close-out-of-range toggle,
and `Close Position Now`. Settings persist in `active-automations.json` and are
enforced every monitoring cycle (price-based TP/SL, OOR close, interval alerts).

## Scripts

| Command | Description |
| --- | --- |
| `npm run check` | Validate config and all RPC routes (no RPC calls) |
| `npm start` | Start the shadow/live poller |
| `npm run once` | Run one evaluation cycle, then exit |
| `npm test` | Syntax checks and unit tests |

> Shadow mode is the default. Live trading requires `DRY_RUN=false`,
> `I_UNDERSTAND_LIVE_TRADING=true` and `PRIVATE_KEY`.

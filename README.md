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

## Multi-Chain RPC Configuration

Set any or all chains in `.env`. Use `_RPC_URL` for a single endpoint or
`_RPC_URLS` for a comma-separated fallback list:

```dotenv
ETH_RPC_URLS=https://ethereum-rpc.publicnode.com,https://eth.llamarpc.com
BSC_RPC_URL=https://bsc-rpc.publicnode.com
BASE_RPC_URLS=https://mainnet.base.org,https://base.llamarpc.com
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
```

`CHAIN` sets the default chain. A position can override it with `chain` or a
numeric `chainId`:

```json
{
  "positions": [
    {
      "label": "WETH/USDC 0.05%",
      "chain": "ethereum",
      "token0": "WETH",
      "token1": "USDC",
      "fee": 500
    },
    {
      "label": "WBNB/USDT 0.1%",
      "chainId": 56,
      "token0": "WBNB",
      "token1": "USDT",
      "fee": 100
    }
  ]
}
```

At inspection time Morpheus resolves the position's target chain and chain ID,
then lazily creates a client bound to that chain's `.env` RPC route. Positions
without `chain`/`chainId` inherit `CHAIN`.

## Telegram Command Menu

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`, then start the bot.
The menu uses non-blocking long polling and accepts commands only from the
configured chat ID.

| Command | Description |
| --- | --- |
| `/start`, `/help` | Command list and bot status |
| `/wallet` | Wallet address, native ETH/BNB balances, per-chain RPC status |
| `/positions` | Open LP positions, chain, pool/ticks, entry and active price |
| `/history` | Last 10 closed positions with timestamp and close reason |
| `/pnl` | Closed-trade count and estimated realized PnL |

`TELEGRAM_ENABLED` controls exit/alert notifications independently.
`TELEGRAM_COMMANDS_ENABLED=false` disables the command menu.

## Scripts

| Command | Description |
| --- | --- |
| `npm run check` | Validate config and all RPC routes (no RPC calls) |
| `npm start` | Start the shadow/live poller |
| `npm run once` | Run one evaluation cycle, then exit |
| `npm test` | Syntax checks and unit tests |

> Shadow mode is the default. Live trading requires `DRY_RUN=false`,
> `I_UNDERSTAND_LIVE_TRADING=true` and `PRIVATE_KEY`.

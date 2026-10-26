# Robinhood Token Intel

Morpheus module for **Robinhood Chain (4663)** token pricing and contract
security. It uses **DeFiLlama** for prices and **direct JSON-RPC via viem** for
on-chain facts, with no GoPlus dependency.

## Layout

```
src/intel/
  index.js          # stable public entry point (re-exports lib/index.js)
  ts/
    defillama.ts    # price, 24h change, confidence
    rpcAnalyzer.ts  # metadata, owner, proxy, bytecode selector scan
    cli.ts          # CLI + report aggregation/rendering
    index.ts        # library barrel
  lib/              # generated ESM + .d.ts (committed for plain-node runtime)
```

`lib/` is checked into the project (not gitignored) so `node index.js` works
without a build step. After changing anything under `ts/`, rebuild:

```powershell
npm run build:intel
npm run check:intel
```

`npm test` runs `build:intel` first, then syntax checks and all unit tests
(including `test/intel.test.js`).

## Import

```js
import {
  analyzeTokenOnChain,
  fetchDefiLlamaPrice,
  runAnalysis,
  renderReport,
} from "./src/intel/index.js";

const token = "0xa2b38467e9b60c016d94977ad37f825da4cd3462";

const price = await fetchDefiLlamaPrice(token);
const onChain = await analyzeTokenOnChain(token);

console.log(price.found, price.priceUsd, price.change24hPct, price.confidence);
console.log(onChain.metadata.symbol, onChain.ownership.status);
console.log(onChain.security.highRisk.map((probe) => probe.signature));

// Or aggregate both sources:
const report = await runAnalysis(token);
console.log(renderReport(report));
```

## CLI

```powershell
# ASSAY (default), human-readable
npm run intel

# Any token, JSON
npm run intel -- 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 --json

# Explicit RPC / timeout
npm run intel -- 0x... --rpc https://robinhood-rpc.publicnode.com --timeout 8000

# Compiled entry directly
node src/intel/lib/cli.js --help
```

Options: `--json`, repeatable `--rpc <url>`, `--timeout <ms>`, `--no-color`,
`--help`. Environment overrides: `TOKEN_ADDRESS`, `ROBINHOOD_RPC_URL`,
`ROBINHOOD_RPC_URLS`, `NO_COLOR`.

## DeFiLlama behaviour

- `GET /prices/current/robinhood:<TOKEN>` gives price, confidence, decimals,
  symbol and timestamp.
- 24h change uses `GET /percentage/robinhood:<TOKEN>`, with a
  `/chart/...?span=24&period=1h` fallback. The result records
  `change24hSource: "percentage" | "chart"`.
- Missing tokens return `found: false` and an `error` string instead of
  throwing. ASSAY is currently not indexed by DeFiLlama; WETH is.

## RPC checks

- ERC-20 `name()`, `symbol()`, `decimals()`, `totalSupply()` (ABI string and
  bytes32 layouts).
- `owner()`: zero address -> `renounced`, non-zero -> `active` (owner code is
  inspected for EOA/contract), revert/no data -> `not_exposed`.
- EIP-1967 implementation slot; implementation bytecode is scanned too.
- Sensitive selectors:

| Selector | Signature | Severity |
| --- | --- | --- |
| `0x40c10f19` | `mint(address,uint256)` | high |
| `0x845600d8` | `pause()` (requested selector) | high |
| `0x8456cb59` | `pause()` (canonical) | high |
| `0x3f4ba83a` | `unpause()` | medium |
| `0x02781667` | `setFee` / tax setter | high |

`PUSH4` dispatcher matches are strong evidence; raw-byte-only matches are
marked `embedded-bytes` and may be compiler metadata/constants.

Risk levels are heuristic:

- `high`: any high-severity selector (token or implementation)
- `medium`: medium selector, active ownership, or upgradeable proxy
- `low`: none of the above, with ownership renounced or not exposed
- `unknown`: no runtime bytecode

This is not an audit. `totalSupply * price` is an FDV estimate, not circulating
market cap.

#!/usr/bin/env node
/**
 * Combined CLI: DeFiLlama pricing + direct-RPC security analysis for a token on
 * Robinhood Chain (4663).
 *
 * Usage (inside Morpheus):
 *   node src/intel/lib/cli.js [TOKEN_ADDRESS]
 *   node src/intel/lib/cli.js 0x... --json
 */

import { pathToFileURL } from "node:url";
import { getAddress, isAddress, type Address } from "viem";
import {
  fetchDefiLlamaPrice,
  type DefiLlamaPriceResult,
} from "./defillama.js";
import {
  analyzeTokenOnChain,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  type RpcAnalysis,
} from "./rpcAnalyzer.js";

export const DEFAULT_TOKEN = "0xa2b38467e9b60c016d94977ad37f825da4cd3462";
export const VERSION = "0.1.0";

export interface CliOptions {
  address: Address;
  json: boolean;
  color: boolean;
  help: boolean;
  rpcUrls: string[];
  timeoutMs: number;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

const HELP_TEXT = `Robinhood Token Intel ${VERSION} (Morpheus module)
Price and on-chain security report for Robinhood Chain (chain id 4663).

Usage:
  npm run intel -- [TOKEN_ADDRESS] [options]
  node src/intel/lib/cli.js [TOKEN_ADDRESS] [options]

Options:
  -j, --json           Print one JSON document (no colors)
      --rpc <url>      Robinhood RPC URL (repeatable, failover in order)
      --timeout <ms>   Per-request timeout in milliseconds (default 10000)
      --no-color       Disable ANSI colors
  -h, --help           Show this help

Defaults:
  token    ${DEFAULT_TOKEN} (ASSAY)
  RPC      https://robinhood-rpc.publicnode.com + public fallbacks

Environment:
  TOKEN_ADDRESS, ROBINHOOD_RPC_URL, ROBINHOOD_RPC_URLS, NO_COLOR

Exit codes:
  0  at least one data source produced usable data
  1  both data sources failed
  64 invalid CLI usage
`;

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} expects a positive integer, got "${value}"`);
  }
  return parsed;
}

export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = Boolean(process.stdout.isTTY),
): CliOptions {
  let json = false;
  let color = isTty && !env.NO_COLOR;
  let help = false;
  let timeoutMs = 10_000;
  const rpcUrls: string[] = [];
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "-j" || arg === "--json") {
      json = true;
      color = false;
      continue;
    }
    if (arg === "--no-color") {
      color = false;
      continue;
    }
    if (arg === "--rpc" || arg.startsWith("--rpc=")) {
      const value = arg === "--rpc" ? argv[++i] : arg.slice("--rpc=".length);
      if (!value || value.startsWith("-")) {
        throw new CliError("--rpc requires a URL");
      }
      rpcUrls.push(value);
      continue;
    }
    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const value = arg === "--timeout" ? argv[++i] : arg.slice("--timeout=".length);
      if (!value || value.startsWith("-")) {
        throw new CliError("--timeout requires milliseconds");
      }
      timeoutMs = parsePositiveInt(value, "--timeout");
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliError(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    throw new CliError(`Expected one token address, got ${positionals.length}`);
  }

  const rawAddress = positionals[0] ?? env.TOKEN_ADDRESS ?? DEFAULT_TOKEN;
  if (!isAddress(rawAddress, { strict: false })) {
    throw new CliError(`Invalid EVM token address: ${rawAddress}`);
  }

  return {
    address: getAddress(rawAddress),
    json,
    color: json ? false : color,
    help,
    rpcUrls,
    timeoutMs,
  };
}

interface Style {
  bold: (value: string) => string;
  dim: (value: string) => string;
  green: (value: string) => string;
  yellow: (value: string) => string;
  red: (value: string) => string;
  cyan: (value: string) => string;
}

function makeStyle(enabled: boolean): Style {
  const wrap = (code: string) => (value: string) =>
    enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    green: wrap("32"),
    yellow: wrap("33"),
    red: wrap("31"),
    cyan: wrap("36"),
  };
}

export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  if (value === 0) return "$0.00";

  const abs = Math.abs(value);
  if (abs >= 1) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: abs >= 1000 ? 2 : 4,
    }).format(value);
  }
  if (abs >= 0.0001) return `$${value.toPrecision(4)}`;
  return `$${value.toExponential(3)}`;
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatConfidence(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

/** Group a decimal string without converting it to a lossy JS number. */
export function formatSupply(value: string | null): string {
  if (value === null) return "n/a";
  const [integer = "0", fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmedFraction = fraction.slice(0, 6).replace(/0+$/, "");
  return trimmedFraction ? `${grouped}.${trimmedFraction}` : grouped;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}


export interface SourceFailure {
  source: "defillama" | "rpc";
  error: string;
  warnings: string[];
}

export interface ReportSummary {
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  change24hPct: number | null;
  confidence: number | null;
  totalSupply: string | null;
  /** totalSupply * price. Not circulating-market-cap. */
  fdvUsd: number | null;
  ownership: string;
  riskLevel: string;
  flags: string[];
  dataSources: {
    defillama: "ok" | "not_indexed" | "error";
    rpc: "ok" | "error";
  };
}

export interface AnalysisReport {
  chain: { id: number; name: string; explorer: string };
  tokenAddress: Address;
  generatedAt: string;
  defillama: DefiLlamaPriceResult | SourceFailure;
  rpc: RpcAnalysis | SourceFailure;
  summary: ReportSummary;
}

function isLlamaResult(
  value: DefiLlamaPriceResult | SourceFailure,
): value is DefiLlamaPriceResult {
  return "found" in value;
}

function isRpcResult(value: RpcAnalysis | SourceFailure): value is RpcAnalysis {
  return "tokenAddress" in value;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request timed out";
    return error.message;
  }
  return String(error);
}

export function buildReport(
  address: Address,
  llamaResult: PromiseSettledResult<DefiLlamaPriceResult>,
  rpcResult: PromiseSettledResult<RpcAnalysis>,
  generatedAt: Date = new Date(),
): AnalysisReport {
  const defillama: DefiLlamaPriceResult | SourceFailure =
    llamaResult.status === "fulfilled"
      ? llamaResult.value
      : {
          source: "defillama",
          error: `DeFiLlama analysis failed: ${describeError(llamaResult.reason)}`,
          warnings: [],
        };

  const rpc: RpcAnalysis | SourceFailure =
    rpcResult.status === "fulfilled"
      ? rpcResult.value
      : {
          source: "rpc",
          error: `RPC analysis failed: ${describeError(rpcResult.reason)}`,
          warnings: [],
        };

  const llama = isLlamaResult(defillama) ? defillama : null;
  const chain = isRpcResult(rpc) ? rpc : null;
  const price = llama?.priceUsd ?? null;
  const supplyNumber =
    chain?.metadata.totalSupply !== null && chain?.metadata.totalSupply !== undefined
      ? Number(chain.metadata.totalSupply)
      : null;
  const fdvUsd =
    price !== null && supplyNumber !== null && Number.isFinite(supplyNumber)
      ? price * supplyNumber
      : null;

  const summary: ReportSummary = {
    name: chain?.metadata.name ?? null,
    symbol: chain?.metadata.symbol ?? llama?.symbol ?? null,
    priceUsd: price,
    change24hPct: llama?.change24hPct ?? null,
    confidence: llama?.confidence ?? null,
    totalSupply: chain?.metadata.totalSupply ?? null,
    fdvUsd,
    ownership: chain?.ownership.status ?? "unknown",
    riskLevel: chain?.security.riskLevel ?? "unknown",
    flags: chain?.security.flags ?? [],
    dataSources: {
      defillama: llama ? (llama.found ? "ok" : "not_indexed") : "error",
      rpc: chain && !chain.error ? "ok" : "error",
    },
  };

  return {
    chain: {
      id: ROBINHOOD_CHAIN_ID,
      name: "Robinhood Chain",
      explorer: ROBINHOOD_EXPLORER_URL,
    },
    tokenAddress: address,
    generatedAt: generatedAt.toISOString(),
    defillama,
    rpc,
    summary,
  };
}

function riskStyled(level: string, style: Style): string {
  const label = level.toUpperCase();
  if (level === "high") return style.red(label);
  if (level === "medium") return style.yellow(label);
  if (level === "low") return style.green(label);
  return style.dim(label);
}

function appendPriceSection(
  lines: string[],
  report: AnalysisReport,
  style: Style,
): void {
  const llama = isLlamaResult(report.defillama) ? report.defillama : null;
  const label = (name: string) => name.padEnd(14);

  lines.push(style.bold("PRICE - DeFiLlama"));
  lines.push("-".repeat(30));

  if (!llama) {
    lines.push(`${label("Status")}${style.red("ERROR")}`);
    lines.push(`${label("Error")}${report.defillama.error}`);
    lines.push("");
    return;
  }

  lines.push(
    `${label("Status")}${
      llama.found ? style.green("INDEXED") : style.yellow("NOT INDEXED")
    }`,
  );
  lines.push(`${label("Price")}${formatUsd(llama.priceUsd)}`);

  const change = formatPercent(llama.change24hPct);
  const changeColored =
    llama.change24hPct === null
      ? change
      : llama.change24hPct >= 0
        ? style.green(change)
        : style.red(change);
  const sourceNote = llama.change24hSource ? ` (${llama.change24hSource})` : "";
  lines.push(`${label("24h change")}${changeColored}${style.dim(sourceNote)}`);
  lines.push(`${label("Confidence")}${formatConfidence(llama.confidence)}`);
  lines.push(`${label("Updated")}${llama.updatedAt ?? "n/a"}`);
  if (llama.error) lines.push(`${label("Note")}${style.yellow(llama.error)}`);

  lines.push("");
}

function appendSecuritySection(
  lines: string[],
  report: AnalysisReport,
  style: Style,
): void {
  const rpc = isRpcResult(report.rpc) ? report.rpc : null;
  const summary = report.summary;
  const label = (name: string) => name.padEnd(14);

  lines.push(style.bold("SECURITY - direct RPC"));
  lines.push("-".repeat(30));

  if (!rpc) {
    lines.push(`${label("Status")}${style.red("ERROR")}`);
    lines.push(`${label("Error")}${report.rpc.error}`);
    lines.push("");
    return;
  }

  lines.push(`${label("Name")}${rpc.metadata.name ?? "n/a"}`);
  lines.push(`${label("Symbol")}${rpc.metadata.symbol ?? "n/a"}`);
  lines.push(`${label("Decimals")}${rpc.metadata.decimals ?? "n/a"}`);
  lines.push(
    `${label("Total supply")}${
      rpc.metadata.totalSupply !== null
        ? `${formatSupply(rpc.metadata.totalSupply)} ${
            rpc.metadata.symbol ?? summary.symbol ?? ""
          }`.trim()
        : "n/a"
    }`,
  );
  lines.push(`${label("FDV estimate")}${formatUsd(summary.fdvUsd)}`);
  lines.push(
    `${label("Owner")}${
      rpc.ownership.status === "renounced"
        ? style.green("RENOUNCED")
        : rpc.ownership.status === "active"
          ? style.yellow(
              `ACTIVE${rpc.ownership.owner ? ` (${rpc.ownership.owner})` : ""}`,
            )
          : style.dim("NOT EXPOSED")
    }`,
  );
  lines.push(`${label("Owner type")}${rpc.ownership.ownerType ?? "n/a"}`);
  lines.push(
    `${label("Proxy")}${
      rpc.security.proxy.isProxy
        ? `yes -> ${rpc.security.proxy.implementation}`
        : "no"
    }`,
  );
  lines.push(`${label("Risk")}${riskStyled(rpc.security.riskLevel, style)}`);
  lines.push(
    `${label("Note")}${rpc.ownership.note}${
      rpc.security.proxy.isProxy ? ` ${rpc.security.proxy.note}` : ""
    }`,
  );
  lines.push("");
  lines.push(`${label("Selectors")}${rpc.security.selectors.length} checked`);

  const detected = rpc.security.selectors.filter((probe) => probe.detected);
  if (detected.length > 0) {
    for (const probe of detected) {
      const evidence =
        probe.dispatch === "push4-dispatch"
          ? `PUSH4 x${probe.push4Matches}`
          : `embedded bytes x${probe.byteMatches} - verify manually`;
      lines.push(
        `  ${style.yellow(probe.signature)} ${style.dim(
          `(${probe.selector}, ${probe.severity}, ${evidence})`,
        )}`,
      );
    }
  } else {
    lines.push(`  ${style.green("none detected")}`);
  }

  const implementationScan = rpc.security.proxy.implementationScan;
  if (implementationScan) {
    lines.push(
      `${label("Impl scan")}${
        implementationScan.detected.length > 0
          ? implementationScan.detected.map((probe) => probe.signature).join(", ")
          : "no sensitive selectors"
      }`,
    );
  }

  if (rpc.error) lines.push(`${label("Error")}${style.red(rpc.error)}`);

  lines.push("");
}

export function renderReport(
  report: AnalysisReport,
  style: Style = makeStyle(false),
): string {
  const rpc = isRpcResult(report.rpc) ? report.rpc : null;
  const summary = report.summary;
  const lines: string[] = [];
  const label = (name: string) => name.padEnd(14);

  const distinctSymbol =
    summary.symbol !== null &&
    summary.name !== null &&
    summary.symbol.toUpperCase() !== summary.name.toUpperCase();
  const title = summary.name
    ? `${summary.name}${distinctSymbol ? ` (${summary.symbol})` : ""}`
    : (summary.symbol ?? "Unknown token");

  lines.push(style.bold("Robinhood Chain Token Report"));
  lines.push("=".repeat(30));
  lines.push(`${label("Token")}${title}`);
  lines.push(`${label("Address")}${report.tokenAddress}`);
  lines.push(`${label("Chain")}${report.chain.name} (${report.chain.id})`);
  lines.push(
    `${label("Contract")}${
      rpc?.contract.isContract
        ? `${rpc.contract.bytecodeSize.toLocaleString("en-US")} bytes${
            rpc.blockNumber ? ` at block ${rpc.blockNumber}` : ""
          }`
        : rpc
          ? "no runtime bytecode (EOA or undeployed)"
          : "unavailable"
    }`,
  );
  lines.push(
    `${label("Explorer")}${report.chain.explorer}/address/${report.tokenAddress}`,
  );
  lines.push(`${label("Generated")}${report.generatedAt}`);
  lines.push("");

  appendPriceSection(lines, report, style);
  appendSecuritySection(lines, report, style);

  const warnings = [
    ...new Set([
      ...report.defillama.warnings,
      ...report.rpc.warnings,
    ]),
  ];

  if (warnings.length > 0) {
    lines.push(style.bold("WARNINGS"));
    lines.push("-".repeat(30));
    for (const warning of warnings) {
      lines.push(`  - ${warning}`);
    }
    lines.push("");
  }

  if (summary.flags.length > 0) {
    lines.push(style.bold("RISK FLAGS"));
    lines.push("-".repeat(30));
    for (const flag of summary.flags) {
      lines.push(`  - ${flag}`);
    }
    lines.push("");
  }

  lines.push(
    style.dim(
      `Sources: DeFiLlama=${summary.dataSources.defillama}, RPC=${summary.dataSources.rpc}. ` +
        "Risk level is a heuristic from bytecode and ownership, not an audit.",
    ),
  );

  return lines.join("\n");
}

export async function runAnalysis(
  address: Address,
  options: { rpcUrls?: string[]; timeoutMs?: number } = {},
): Promise<AnalysisReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const rpcOptions =
    options.rpcUrls && options.rpcUrls.length > 0
      ? { rpcUrls: options.rpcUrls, timeoutMs }
      : { timeoutMs };

  const [llama, rpc] = await Promise.allSettled([
    fetchDefiLlamaPrice(address, { timeoutMs }),
    analyzeTokenOnChain(address, rpcOptions),
  ]);

  return buildReport(address, llama, rpc);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`Error: ${error.message}\n`);
      console.error(HELP_TEXT);
      process.exitCode = 64;
      return;
    }
    throw error;
  }

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  try {
    const report = await runAnalysis(options.address, {
      rpcUrls: options.rpcUrls,
      timeoutMs: options.timeoutMs,
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderReport(report, makeStyle(options.color)));
    }

    const llamaUsable =
      isLlamaResult(report.defillama) && report.defillama.found;
    const rpcUsable =
      isRpcResult(report.rpc) && report.rpc.error === null;
    process.exitCode = llamaUsable || rpcUsable ? 0 : 1;
  } catch (error) {
    console.error(`Fatal: ${describeError(error)}`);
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  void main();
}

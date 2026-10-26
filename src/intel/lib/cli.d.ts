#!/usr/bin/env node
/**
 * Combined CLI: DeFiLlama pricing + direct-RPC security analysis for a token on
 * Robinhood Chain (4663).
 *
 * Usage (inside Morpheus):
 *   node src/intel/lib/cli.js [TOKEN_ADDRESS]
 *   node src/intel/lib/cli.js 0x... --json
 */
import { type Address } from "viem";
import { type DefiLlamaPriceResult } from "./defillama.js";
import { type RpcAnalysis } from "./rpcAnalyzer.js";
export declare const DEFAULT_TOKEN = "0xa2b38467e9b60c016d94977ad37f825da4cd3462";
export declare const VERSION = "0.1.0";
export interface CliOptions {
    address: Address;
    json: boolean;
    color: boolean;
    help: boolean;
    rpcUrls: string[];
    timeoutMs: number;
}
export declare class CliError extends Error {
    constructor(message: string);
}
export declare function parseArgs(argv: readonly string[], env?: NodeJS.ProcessEnv, isTty?: boolean): CliOptions;
interface Style {
    bold: (value: string) => string;
    dim: (value: string) => string;
    green: (value: string) => string;
    yellow: (value: string) => string;
    red: (value: string) => string;
    cyan: (value: string) => string;
}
export declare function formatUsd(value: number | null): string;
export declare function formatPercent(value: number | null): string;
export declare function formatConfidence(value: number | null): string;
/** Group a decimal string without converting it to a lossy JS number. */
export declare function formatSupply(value: string | null): string;
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
    chain: {
        id: number;
        name: string;
        explorer: string;
    };
    tokenAddress: Address;
    generatedAt: string;
    defillama: DefiLlamaPriceResult | SourceFailure;
    rpc: RpcAnalysis | SourceFailure;
    summary: ReportSummary;
}
export declare function buildReport(address: Address, llamaResult: PromiseSettledResult<DefiLlamaPriceResult>, rpcResult: PromiseSettledResult<RpcAnalysis>, generatedAt?: Date): AnalysisReport;
export declare function renderReport(report: AnalysisReport, style?: Style): string;
export declare function runAnalysis(address: Address, options?: {
    rpcUrls?: string[];
    timeoutMs?: number;
}): Promise<AnalysisReport>;
export declare function main(argv?: readonly string[]): Promise<void>;
export {};

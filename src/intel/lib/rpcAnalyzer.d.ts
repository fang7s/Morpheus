/**
 * Direct-RPC token analyzer for Robinhood Chain (chain id 4663).
 *
 * No GoPlus, no third-party security API: ERC-20 metadata, ownership state,
 * EIP-1967 proxy discovery and sensitive-selector bytecode scanning are all
 * performed against the chain itself.
 */
import { type Address, type Chain, type Hex, type PublicClient } from "viem";
export declare const ROBINHOOD_CHAIN_ID = 4663;
/**
 * Public endpoints, ordered by preference. The transport fails over in order.
 * PublicNode is first because the official host failed TLS during validation;
 * the official endpoint remains as the second fallback. Override with --rpc or
 * ROBINHOOD_RPC_URL(S).
 */
export declare const ROBINHOOD_RPC_URLS: readonly ["https://robinhood-rpc.publicnode.com", "https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"];
export declare const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";
export declare const DEFAULT_RPC_TIMEOUT_MS = 10000;
export declare const robinhoodChain: Chain;
/**
 * Selectors called out in the requirements. `pause()` is normally
 * 0x8456cb59; 0x845600d8 is kept because the task explicitly asks for it.
 * Matches are evidence, not proof: dispatch matches (PUSH4) are strong,
 * raw byte matches may be compiler metadata or constants.
 */
export declare const SENSITIVE_SELECTORS: readonly SelectorDefinition[];
export interface SelectorDefinition {
    selector: Hex;
    signature: string;
    label: string;
    severity: "high" | "medium";
}
export type SelectorDispatch = "push4-dispatch" | "embedded-bytes" | "none";
export interface SelectorProbe extends SelectorDefinition {
    detected: boolean;
    dispatch: SelectorDispatch;
    /** Number of `PUSH4 <selector>` dispatcher entries. */
    push4Matches: number;
    /** Number of raw selector byte occurrences (includes metadata/constants). */
    byteMatches: number;
}
export interface BytecodeScan {
    isContract: boolean;
    sizeBytes: number;
    selectors: SelectorProbe[];
    detected: SelectorProbe[];
    highRisk: SelectorProbe[];
}
export type OwnerStatus = "renounced" | "active" | "not_exposed";
export interface OwnershipInfo {
    status: OwnerStatus;
    owner: Address | null;
    ownerType: "eoa" | "contract" | null;
    note: string;
}
export interface ProxyInfo {
    isProxy: boolean;
    implementation: Address | null;
    implementationScan: BytecodeScan | null;
    note: string;
}
export interface TokenMetadata {
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    totalSupplyRaw: string | null;
    totalSupply: string | null;
}
export interface RiskAssessment {
    level: "low" | "medium" | "high" | "unknown";
    flags: string[];
}
export interface RpcAnalyzerOptions {
    /** One URL, a comma/space separated list, or an array. */
    rpcUrls?: string | readonly string[];
    /** Per-request timeout in milliseconds. Defaults to 10s. */
    timeoutMs?: number;
    /** Inject a client for tests; otherwise one is built from `rpcUrls`. */
    client?: PublicClient;
}
export interface RpcAnalysis {
    source: "rpc";
    chainId: number | null;
    expectedChainId: typeof ROBINHOOD_CHAIN_ID;
    chainName: string;
    tokenAddress: Address;
    blockNumber: string | null;
    contract: {
        isContract: boolean;
        bytecodeSize: number;
    };
    metadata: TokenMetadata;
    ownership: OwnershipInfo;
    security: {
        selectors: SelectorProbe[];
        highRisk: SelectorProbe[];
        proxy: ProxyInfo;
        riskLevel: RiskAssessment["level"];
        flags: string[];
    };
    error: string | null;
    warnings: string[];
}
/**
 * Resolution order: explicit option, ROBINHOOD_RPC_URLS, ROBINHOOD_RPC_URL,
 * then the built-in public endpoints.
 */
export declare function resolveRpcUrls(override?: string | readonly string[]): string[];
export declare function createRobinhoodClient(options?: RpcAnalyzerOptions): PublicClient;
/**
 * ERC-20 `name()`/`symbol()` may return an ABI-encoded string or a right-padded
 * bytes32 (older tokens). Try the standard string layout first, then bytes32.
 */
export declare function decodeStringResult(data?: Hex | null): string | null;
/** Pure helper so ownership classification can be unit-tested. */
export declare function classifyOwner(data?: Hex | null): {
    status: OwnerStatus;
    owner: Address | null;
};
/**
 * Scan runtime bytecode for sensitive function selectors.
 *
 * Solidity dispatchers compare against selectors with `PUSH4 <selector>`
 * (0x63 + 4 bytes), so those matches are strong evidence. A raw byte match can
 * also be compiler metadata or a pushed constant, hence `dispatch` is reported.
 */
export declare function scanBytecode(bytecode?: Hex | string | null): BytecodeScan;
/**
 * Heuristic only: an active owner is a centralisation risk, not proof of
 * malicious behaviour. High-risk selectors upgrade the level to "high".
 */
export declare function assessRisk(input: {
    isContract: boolean;
    ownership: OwnershipInfo;
    scan: BytecodeScan;
    proxy: ProxyInfo;
}): RiskAssessment;
/**
 * Analyze one token with direct RPC calls. Invalid addresses throw (programmer
 * error); transport/decoding problems are returned in `error`/`warnings`.
 */
export declare function analyzeTokenOnChain(tokenAddress: string, options?: RpcAnalyzerOptions): Promise<RpcAnalysis>;

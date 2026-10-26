/**
 * Direct-RPC token analyzer for Robinhood Chain (chain id 4663).
 *
 * No GoPlus, no third-party security API: ERC-20 metadata, ownership state,
 * EIP-1967 proxy discovery and sensitive-selector bytecode scanning are all
 * performed against the chain itself.
 */
import { createPublicClient, decodeAbiParameters, defineChain, fallback, formatUnits, getAddress, hexToString, http, isAddress, zeroAddress, } from "viem";
export const ROBINHOOD_CHAIN_ID = 4663;
/**
 * Public endpoints, ordered by preference. The transport fails over in order.
 * PublicNode is first because the official host failed TLS during validation;
 * the official endpoint remains as the second fallback. Override with --rpc or
 * ROBINHOOD_RPC_URL(S).
 */
export const ROBINHOOD_RPC_URLS = [
    "https://robinhood-rpc.publicnode.com",
    "https://rpc.mainnet.chain.robinhood.com",
    "https://robinhood.drpc.org",
];
export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;
export const robinhoodChain = defineChain({
    id: ROBINHOOD_CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
        default: { http: [...ROBINHOOD_RPC_URLS] },
    },
    blockExplorers: {
        default: { name: "Robinhood Chain Explorer", url: ROBINHOOD_EXPLORER_URL },
    },
});
const SELECTORS = {
    name: "0x06fdde03",
    symbol: "0x95d89b41",
    decimals: "0x313ce567",
    totalSupply: "0x18160ddd",
    owner: "0x8da5cb5b",
};
/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/**
 * Selectors called out in the requirements. `pause()` is normally
 * 0x8456cb59; 0x845600d8 is kept because the task explicitly asks for it.
 * Matches are evidence, not proof: dispatch matches (PUSH4) are strong,
 * raw byte matches may be compiler metadata or constants.
 */
export const SENSITIVE_SELECTORS = [
    {
        selector: "0x40c10f19",
        signature: "mint(address,uint256)",
        label: "Mint / supply inflation",
        severity: "high",
    },
    {
        selector: "0x845600d8",
        signature: "pause() [requested selector]",
        label: "Pause / trading halt",
        severity: "high",
    },
    {
        selector: "0x8456cb59",
        signature: "pause()",
        label: "Pause / trading halt",
        severity: "high",
    },
    {
        selector: "0x3f4ba83a",
        signature: "unpause()",
        label: "Unpause / trading resume",
        severity: "medium",
    },
    {
        selector: "0x02781667",
        signature: "setFee / tax setter",
        label: "Fee / tax modifier",
        severity: "high",
    },
];
function splitUrlList(value) {
    if (!value)
        return [];
    const items = typeof value === "string"
        ? value.split(/[\s,]+/)
        : value.flatMap((entry) => entry.split(/[\s,]+/));
    return items.map((item) => item.trim()).filter(Boolean);
}
/**
 * Resolution order: explicit option, ROBINHOOD_RPC_URLS, ROBINHOOD_RPC_URL,
 * then the built-in public endpoints.
 */
export function resolveRpcUrls(override) {
    const explicit = splitUrlList(override);
    const envList = splitUrlList(process.env.ROBINHOOD_RPC_URLS);
    const envSingle = splitUrlList(process.env.ROBINHOOD_RPC_URL);
    const selected = explicit.length > 0
        ? explicit
        : envList.length > 0
            ? envList
            : envSingle.length > 0
                ? envSingle
                : [...ROBINHOOD_RPC_URLS];
    const unique = [];
    for (const url of selected) {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            throw new Error(`Invalid Robinhood RPC URL: ${url}`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error(`RPC URL must use http(s): ${url}`);
        }
        if (!unique.includes(url))
            unique.push(url);
    }
    if (unique.length === 0) {
        throw new Error("No Robinhood Chain RPC URLs configured.");
    }
    return unique;
}
export function createRobinhoodClient(options = {}) {
    const urls = resolveRpcUrls(options.rpcUrls);
    const timeout = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    return createPublicClient({
        chain: robinhoodChain,
        transport: fallback(urls.map((url) => http(url, { timeout, retryCount: 0 })), { rank: false }),
    });
}
function describeError(error) {
    if (error instanceof Error) {
        if (error.name === "AbortError")
            return "request timed out";
    }
    const message = error instanceof Error ? error.message : String(error);
    const firstLine = message.split(/\r?\n/).find((line) => line.trim()) ?? message;
    return firstLine.length > 300 ? `${firstLine.slice(0, 297)}...` : firstLine;
}
function cleanText(value) {
    const cleaned = value
        .replace(/\u0000+/g, "")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim();
    return cleaned.length > 0 ? cleaned : null;
}
/**
 * ERC-20 `name()`/`symbol()` may return an ABI-encoded string or a right-padded
 * bytes32 (older tokens). Try the standard string layout first, then bytes32.
 */
export function decodeStringResult(data) {
    if (!data || data === "0x")
        return null;
    try {
        const [decoded] = decodeAbiParameters([{ type: "string" }], data);
        const text = cleanText(decoded);
        if (text !== null)
            return text;
    }
    catch {
        // Fall through to the bytes32 layout.
    }
    try {
        if (data.length < 66)
            return null;
        const word = data.slice(0, 66);
        return cleanText(hexToString(word));
    }
    catch {
        return null;
    }
}
async function readString(client, address, selector) {
    try {
        const { data } = await client.call({ to: address, data: selector });
        return { value: decodeStringResult(data), error: null };
    }
    catch (error) {
        return { value: null, error: describeError(error) };
    }
}
async function readUint(client, address, selector, max) {
    try {
        const { data } = await client.call({ to: address, data: selector });
        if (!data || data === "0x")
            return { value: null, error: "empty response" };
        const value = BigInt(data);
        if (value > max)
            return { value: null, error: "value out of range" };
        return { value, error: null };
    }
    catch (error) {
        return { value: null, error: describeError(error) };
    }
}
async function readMetadata(client, address, warnings) {
    const [name, symbol, decimals, supply] = await Promise.all([
        readString(client, address, SELECTORS.name),
        readString(client, address, SELECTORS.symbol),
        readUint(client, address, SELECTORS.decimals, 255n),
        readUint(client, address, SELECTORS.totalSupply, 2n ** 256n - 1n),
    ]);
    if (name.error)
        warnings.push(`name() read failed: ${name.error}`);
    if (symbol.error)
        warnings.push(`symbol() read failed: ${symbol.error}`);
    if (decimals.error)
        warnings.push(`decimals() read failed: ${decimals.error}`);
    if (supply.error)
        warnings.push(`totalSupply() read failed: ${supply.error}`);
    const decimalsValue = decimals.value !== null ? Number(decimals.value) : null;
    return {
        name: name.value,
        symbol: symbol.value,
        decimals: decimalsValue,
        totalSupplyRaw: supply.value !== null ? supply.value.toString() : null,
        totalSupply: supply.value !== null && decimalsValue !== null
            ? formatUnits(supply.value, decimalsValue)
            : null,
    };
}
/** Pure helper so ownership classification can be unit-tested. */
export function classifyOwner(data) {
    if (!data || data === "0x") {
        return { status: "not_exposed", owner: null };
    }
    try {
        const [decoded] = decodeAbiParameters([{ type: "address" }], data);
        const owner = getAddress(decoded);
        return {
            status: owner === zeroAddress ? "renounced" : "active",
            owner,
        };
    }
    catch {
        return { status: "not_exposed", owner: null };
    }
}
async function readOwnership(client, address, warnings) {
    let result;
    try {
        const { data } = await client.call({ to: address, data: SELECTORS.owner });
        result = classifyOwner(data);
    }
    catch {
        // No standard owner() function, or it reverted. The caller adds one
        // consolidated warning; viem's multi-line revert dump is not useful here.
        return {
            status: "not_exposed",
            owner: null,
            ownerType: null,
            note: "No callable owner() function was found; renouncement cannot be verified.",
        };
    }
    if (result.status === "not_exposed" || result.owner === null) {
        return {
            status: "not_exposed",
            owner: null,
            ownerType: null,
            note: "owner() returned no address; renouncement cannot be verified.",
        };
    }
    if (result.status === "renounced") {
        return {
            status: "renounced",
            owner: zeroAddress,
            ownerType: null,
            note: "owner() returns the zero address: ownership is renounced.",
        };
    }
    let ownerType = null;
    try {
        const code = await client.getCode({ address: result.owner });
        ownerType = !code || code === "0x" ? "eoa" : "contract";
    }
    catch (error) {
        warnings.push(`Unable to inspect owner bytecode: ${describeError(error)}`);
    }
    return {
        status: "active",
        owner: result.owner,
        ownerType,
        note: ownerType === "contract"
            ? "owner() is a contract (multisig, timelock or another contract)."
            : ownerType === "eoa"
                ? "owner() is an EOA and can still act on the token."
                : "Owner is active; owner account type could not be determined.",
    };
}
function storageWordToAddress(word) {
    const hex = word.replace(/^0x/, "").padStart(64, "0");
    if (/^0+$/.test(hex))
        return null;
    try {
        return getAddress(`0x${hex.slice(24)}`);
    }
    catch {
        return null;
    }
}
async function readProxy(client, address, warnings) {
    try {
        const word = await client.getStorageAt({
            address,
            slot: EIP1967_IMPLEMENTATION_SLOT,
        });
        const implementation = word ? storageWordToAddress(word) : null;
        if (implementation === null) {
            return {
                isProxy: false,
                implementation: null,
                implementationScan: null,
                note: "No EIP-1967 implementation address at the standard slot.",
            };
        }
        let implementationScan = null;
        try {
            const code = await client.getCode({ address: implementation });
            implementationScan = scanBytecode(code);
        }
        catch (error) {
            warnings.push(`Implementation bytecode read failed: ${describeError(error)}`);
        }
        return {
            isProxy: true,
            implementation,
            implementationScan,
            note: "EIP-1967 upgradeable proxy; implementation bytecode was scanned.",
        };
    }
    catch (error) {
        warnings.push(`EIP-1967 implementation slot read failed: ${describeError(error)}`);
        return {
            isProxy: false,
            implementation: null,
            implementationScan: null,
            note: "Proxy status could not be determined from the EIP-1967 slot.",
        };
    }
}
function countOccurrences(haystack, needle) {
    if (!needle)
        return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}
/**
 * Scan runtime bytecode for sensitive function selectors.
 *
 * Solidity dispatchers compare against selectors with `PUSH4 <selector>`
 * (0x63 + 4 bytes), so those matches are strong evidence. A raw byte match can
 * also be compiler metadata or a pushed constant, hence `dispatch` is reported.
 */
export function scanBytecode(bytecode) {
    const hex = (bytecode ?? "").toLowerCase().replace(/^0x/, "");
    const isContract = hex.length > 0;
    const selectors = SENSITIVE_SELECTORS.map((definition) => {
        const needle = definition.selector.slice(2);
        const push4Matches = countOccurrences(hex, `63${needle}`);
        const byteMatches = countOccurrences(hex, needle);
        const dispatch = push4Matches > 0 ? "push4-dispatch" : byteMatches > 0 ? "embedded-bytes" : "none";
        return {
            ...definition,
            detected: dispatch !== "none",
            dispatch,
            push4Matches,
            byteMatches,
        };
    });
    return {
        isContract,
        sizeBytes: hex.length / 2,
        selectors,
        detected: selectors.filter((probe) => probe.detected),
        highRisk: selectors.filter((probe) => probe.detected && probe.severity === "high"),
    };
}
/**
 * Heuristic only: an active owner is a centralisation risk, not proof of
 * malicious behaviour. High-risk selectors upgrade the level to "high".
 */
export function assessRisk(input) {
    const { isContract, ownership, scan, proxy } = input;
    const flags = [];
    if (!isContract) {
        return {
            level: "unknown",
            flags: [
                "No contract bytecode at this address on Robinhood Chain; it may be an EOA or undeployed.",
            ],
        };
    }
    for (const probe of scan.detected) {
        const evidence = probe.dispatch === "push4-dispatch"
            ? "dispatcher entry"
            : "embedded bytes; possible metadata/constant false positive";
        flags.push(`${probe.signature} detected in runtime bytecode (${probe.label}; ${probe.severity} risk; ${evidence}).`);
    }
    if (proxy.isProxy) {
        flags.push(`Upgradeable EIP-1967 proxy${proxy.implementation ? ` -> ${proxy.implementation}` : ""}; token logic can be replaced.`);
        for (const probe of proxy.implementationScan?.detected ?? []) {
            if (probe.severity !== "high")
                continue;
            flags.push(`[implementation] ${probe.signature} detected (${probe.label}; high risk).`);
        }
    }
    if (ownership.status === "active") {
        flags.push(`Ownership is active (${ownership.owner ?? "unknown owner"}); the owner can still change token behaviour.`);
    }
    else if (ownership.status === "not_exposed") {
        flags.push("owner() is not exposed, so renouncement cannot be verified from this contract.");
    }
    const highRiskFound = scan.highRisk.length > 0 ||
        (proxy.implementationScan?.highRisk.length ?? 0) > 0;
    const mediumRiskFound = scan.detected.some((probe) => probe.severity === "medium");
    const level = highRiskFound
        ? "high"
        : mediumRiskFound || ownership.status === "active" || proxy.isProxy
            ? "medium"
            : "low";
    return { level, flags };
}
function emptyMetadata() {
    return {
        name: null,
        symbol: null,
        decimals: null,
        totalSupplyRaw: null,
        totalSupply: null,
    };
}
/**
 * Analyze one token with direct RPC calls. Invalid addresses throw (programmer
 * error); transport/decoding problems are returned in `error`/`warnings`.
 */
export async function analyzeTokenOnChain(tokenAddress, options = {}) {
    if (!isAddress(tokenAddress, { strict: false })) {
        throw new Error(`Invalid EVM address: ${tokenAddress}`);
    }
    const address = getAddress(tokenAddress);
    const client = options.client ?? createRobinhoodClient(options);
    const warnings = [];
    const [chainIdResult, blockResult, codeResult] = await Promise.allSettled([
        client.getChainId(),
        client.getBlockNumber(),
        client.getCode({ address }),
    ]);
    let chainId = null;
    if (chainIdResult.status === "fulfilled") {
        chainId = chainIdResult.value;
        if (chainId !== ROBINHOOD_CHAIN_ID) {
            warnings.push(`RPC reports chain id ${chainId}, expected ${ROBINHOOD_CHAIN_ID}. Results may come from the wrong network.`);
        }
    }
    else {
        warnings.push(`eth_chainId failed: ${describeError(chainIdResult.reason)}`);
    }
    let blockNumber = null;
    if (blockResult.status === "fulfilled") {
        blockNumber = blockResult.value.toString();
    }
    else {
        warnings.push(`eth_blockNumber failed: ${describeError(blockResult.reason)}`);
    }
    const base = {
        source: "rpc",
        chainId,
        expectedChainId: ROBINHOOD_CHAIN_ID,
        chainName: robinhoodChain.name,
        tokenAddress: address,
        blockNumber,
        contract: { isContract: false, bytecodeSize: 0 },
        metadata: emptyMetadata(),
        ownership: {
            status: "not_exposed",
            owner: null,
            ownerType: null,
            note: "Not analyzed.",
        },
        security: {
            selectors: [],
            highRisk: [],
            proxy: {
                isProxy: false,
                implementation: null,
                implementationScan: null,
                note: "Not analyzed.",
            },
            riskLevel: "unknown",
            flags: [],
        },
        error: null,
        warnings,
    };
    if (codeResult.status === "rejected") {
        return {
            ...base,
            error: `Unable to read contract bytecode: ${describeError(codeResult.reason)}`,
        };
    }
    const scan = scanBytecode(codeResult.value);
    if (!scan.isContract) {
        const ownership = {
            status: "not_exposed",
            owner: null,
            ownerType: null,
            note: "No contract code exists at this address.",
        };
        const proxy = {
            isProxy: false,
            implementation: null,
            implementationScan: null,
            note: "Not applicable: no contract bytecode.",
        };
        const risk = assessRisk({ isContract: false, ownership, scan, proxy });
        warnings.push("Address has no runtime bytecode; it may be an EOA or not deployed on Robinhood Chain.");
        return {
            ...base,
            contract: { isContract: false, bytecodeSize: 0 },
            ownership,
            security: {
                selectors: scan.selectors,
                highRisk: [],
                proxy,
                riskLevel: risk.level,
                flags: risk.flags,
            },
        };
    }
    const [metadata, ownership, proxy] = await Promise.all([
        readMetadata(client, address, warnings),
        readOwnership(client, address, warnings),
        readProxy(client, address, warnings),
    ]);
    if (ownership.status === "not_exposed") {
        warnings.push("Ownership cannot be verified because the contract does not expose owner().");
    }
    const allProbes = [
        ...scan.detected,
        ...(proxy.implementationScan?.detected ?? []),
    ];
    for (const probe of allProbes) {
        if (probe.dispatch === "embedded-bytes") {
            warnings.push(`${probe.signature} matched only in non-dispatch bytes; verify manually before treating it as a real function.`);
        }
    }
    const risk = assessRisk({
        isContract: true,
        ownership,
        scan,
        proxy,
    });
    return {
        ...base,
        contract: { isContract: true, bytecodeSize: scan.sizeBytes },
        metadata,
        ownership,
        security: {
            selectors: scan.selectors,
            highRisk: scan.highRisk,
            proxy,
            riskLevel: risk.level,
            flags: risk.flags,
        },
    };
}

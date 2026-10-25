/** Stable position identity used by the runtime tracker and command menu. */
export function positionKey(position) {
  return `${position.chain || "unknown"}:${String(position.pool || "").toLowerCase()}:`
    + `${position.tokenId || position.label}`;
}

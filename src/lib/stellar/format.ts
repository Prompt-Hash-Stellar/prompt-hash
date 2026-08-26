/**
 * Converts stroops (smallest unit) to XLM string
 * 1 XLM = 10,000,000 stroops
 */
export function stroopsToXlmString(stroops: bigint): string {
  const STROOPS_PER_XLM = 10_000_000n;
  if (stroops === 0n) return "0";
  const sign = stroops < 0n ? "-" : "";
  const abs = stroops < 0n ? -stroops : stroops;
  const integer = abs / STROOPS_PER_XLM;
  const remainder = abs % STROOPS_PER_XLM;
  if (remainder === 0n) return `${sign}${integer.toString()}`;
  const frac = remainder.toString().padStart(7, "0");
  // trim trailing zeros for display but keep exactness for parsing
  const trimmedFrac = frac.replace(/0+$/u, "");
  return `${sign}${integer.toString()}.${trimmedFrac}`;
}

/**
 * Converts XLM to stroops
 */
export function xlmToStroops(xlm: number | string): bigint {
  const STROOPS_PER_XLM = 10_000_000n;
  const asStr = typeof xlm === "number" ? String(xlm) : xlm;
  if (typeof asStr !== "string") throw new Error("Invalid XLM input");
  const trimmed = asStr.trim();
  if (trimmed.length === 0) throw new Error("Empty XLM value");
  if (/e/i.test(trimmed)) throw new Error("Scientific notation not supported");

  const sign = trimmed.startsWith("-") ? -1n : 1n;
  const unsigned = trimmed.startsWith("+") || trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;
  const parts = unsigned.split(".");
  if (parts.length > 2) throw new Error("Invalid XLM value");
  const intPart = parts[0] === "" ? "0" : parts[0];
  const fracPart = parts[1] ?? "";
  if (!/^\d+$/.test(intPart)) throw new Error("Invalid integer part in XLM value");
  if (fracPart && !/^\d+$/.test(fracPart)) throw new Error("Invalid fractional part in XLM value");
  if (fracPart.length > 7) throw new Error("Too many decimal places; max 7 allowed");

  const intBig = BigInt(intPart);
  const fracPadded = (fracPart + "0000000").slice(0, 7);
  const fracBig = BigInt(fracPadded);
  return sign * (intBig * STROOPS_PER_XLM + fracBig);
}

/**
 * Formats a price in stroops as a human-readable XLM label.
 */
export function formatPriceLabel(stroops: bigint): string {
  const xlmStr = stroopsToXlmString(stroops);
  return `${xlmStr} XLM`;
}

/**
 * Formats an address for display (truncated)
 */
export function formatAddress(
  address: string,
  prefixLength = 8,
  suffixLength = 4,
): string {
  if (address.length <= prefixLength + suffixLength) {
    return address;
  }
  return `${address.slice(0, prefixLength)}...${address.slice(-suffixLength)}`;
}


/**
 * Converts stroops (smallest unit) to XLM string
 * 1 XLM = 10,000,000 stroops
 */
export const STROOPS_PER_XLM = 10_000_000n;

export function stroopsToXlmString(stroops: bigint): string {
  const sign = stroops < 0n ? "-" : "";
  const absolute = stroops < 0n ? -stroops : stroops;
  const whole = absolute / STROOPS_PER_XLM;
  const remainder = absolute % STROOPS_PER_XLM;

  if (remainder === 0n) {
    return `${sign}${whole}`;
  }

  const fraction = remainder.toString().padStart(7, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fraction}`;
}

/**
 * Converts XLM to stroops
 */
export function xlmToStroops(xlm: string): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,7}))?$/.exec(xlm.trim());
  if (!match) {
    throw new Error("Enter a valid XLM amount with up to 7 decimal places.");
  }

  const [, sign, whole, fraction = ""] = match;
  const absolute =
    BigInt(whole) * STROOPS_PER_XLM + BigInt(fraction.padEnd(7, "0") || "0");
  return sign === "-" ? -absolute : absolute;
}

/**
 * Formats an exact stroop amount for display at a fixed decimal precision.
 * Rounding is isolated here so stored and aggregated values remain bigint.
 */
export function formatStroopsToFixedXlm(
  stroops: bigint,
  fractionDigits: number,
): string {
  if (
    !Number.isInteger(fractionDigits) ||
    fractionDigits < 0 ||
    fractionDigits > 7
  ) {
    throw new RangeError("fractionDigits must be an integer between 0 and 7.");
  }

  const sign = stroops < 0n ? "-" : "";
  const absolute = stroops < 0n ? -stroops : stroops;
  const roundingUnit = 10n ** BigInt(7 - fractionDigits);
  const roundedUnits = (absolute + roundingUnit / 2n) / roundingUnit;

  if (fractionDigits === 0) {
    return `${sign}${roundedUnits}`;
  }

  const displayScale = 10n ** BigInt(fractionDigits);
  const whole = roundedUnits / displayScale;
  const fraction = (roundedUnits % displayScale)
    .toString()
    .padStart(fractionDigits, "0");
  return `${sign}${whole}.${fraction}`;
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

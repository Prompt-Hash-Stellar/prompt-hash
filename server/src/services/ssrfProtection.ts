/**
 * ssrfProtection.ts — SSRF Prevention for Webhooks (#148)
 *
 * Validates webhook URLs at registration and delivery time to prevent
 * Server-Side Request Forgery (SSRF) targeting loopback, private networks,
 * link-local/cloud metadata, non-standard ports, credential insertion,
 * DNS rebinding, and redirect bypasses.
 */

import net from "net";
import dns from "dns/promises";

export interface SsrfValidationResult {
  valid: boolean;
  reason?: string;
  resolvedIp?: string;
  parsedUrl?: URL;
}

const ALLOWED_PORTS = new Set([443, 8443]);

/**
 * Parses numeric or encoded IPv4 formats (decimal int, octal, hex, dotted formats).
 * Returns standard dotted-quad IPv4 string if matched, or null if not a numeric IP.
 */
export function parseNumericOrEncodedIp(hostname: string): string | null {
  let cleanHost = hostname.trim();
  if (cleanHost.startsWith("[") && cleanHost.endsWith("]")) {
    cleanHost = cleanHost.slice(1, -1);
  }

  if (net.isIPv4(cleanHost) || net.isIPv6(cleanHost)) {
    return cleanHost;
  }

  // Pure integer / hex e.g. "2130706433" (127.0.0.1) or "0x7f000001"
  if (/^(0x[0-9a-f]+|\d+)$/i.test(cleanHost)) {
    try {
      const val = Number(BigInt(cleanHost));
      if (val >= 0 && val <= 0xffffffff) {
        const a = (val >>> 24) & 255;
        const b = (val >>> 16) & 255;
        const c = (val >>> 8) & 255;
        const d = val & 255;
        return `${a}.${b}.${c}.${d}`;
      }
    } catch {
      return null;
    }
  }

  // Dotted notation e.g. "0177.0.0.1", "0x7f.0.0.1", "127.1"
  const parts = cleanHost.split(".");
  if (parts.length >= 1 && parts.length <= 4) {
    const parsedParts: number[] = [];
    for (const part of parts) {
      if (!/^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(part)) {
        return null;
      }
      let num: number;
      if (part.toLowerCase().startsWith("0x")) {
        num = parseInt(part, 16);
      } else if (part.length > 1 && part.startsWith("0") && /^[0-7]+$/.test(part)) {
        num = parseInt(part, 8);
      } else {
        num = parseInt(part, 10);
      }
      if (isNaN(num) || num < 0) return null;
      parsedParts.push(num);
    }

    if (parsedParts.length === 4) {
      if (parsedParts.every((p) => p <= 255)) {
        return parsedParts.join(".");
      }
    } else if (parsedParts.length === 2) {
      // 127.1 -> 127.0.0.1
      const [a, b] = parsedParts;
      if (a <= 255 && b <= 0xffffff) {
        return `${a}.${(b >>> 16) & 255}.${(b >>> 8) & 255}.${b & 255}`;
      }
    } else if (parsedParts.length === 3) {
      // 127.0.1 -> 127.0.0.1
      const [a, b, c] = parsedParts;
      if (a <= 255 && b <= 255 && c <= 0xffff) {
        return `${a}.${b}.${(c >>> 8) & 255}.${c & 255}`;
      }
    }
  }

  return null;
}

/**
 * Checks if an IP address (IPv4 or IPv6) falls within private, loopback,
 * link-local, cloud metadata, or reserved ranges.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (!ip) return true;

  // Handle IPv6 mapped IPv4 addresses (e.g., ::ffff:127.0.0.1)
  if (ip.toLowerCase().startsWith("::ffff:")) {
    const ipv4Part = ip.slice(7);
    if (net.isIPv4(ipv4Part)) {
      return isPrivateOrReservedIp(ipv4Part);
    }
    // Hex IPv4 in mapped IPv6 e.g. ::ffff:7f00:0001
    const parts = ipv4Part.split(":");
    if (parts.length === 2) {
      const high = parseInt(parts[0], 16);
      const low = parseInt(parts[1], 16);
      if (!isNaN(high) && !isNaN(low)) {
        const ipStr = `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
        return isPrivateOrReservedIp(ipStr);
      }
    }
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }

    const [a, b, c, d] = parts;

    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;

    // 10.0.0.0/8 (Private)
    if (a === 10) return true;

    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;

    // 100.64.0.0/10 (Shared Address Space / CGNAT)
    if (a === 100 && b >= 64 && b <= 127) return true;

    // 169.254.0.0/16 (Link-Local & Cloud Metadata e.g. 169.254.169.254)
    if (a === 169 && b === 254) return true;

    // 172.16.0.0/12 (Private)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (a === 192 && b === 0 && c === 0) return true;

    // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 0 && c === 2) return true;

    // 192.88.99.0/24 (6to4 Relay Anycast)
    if (a === 192 && b === 88 && c === 99) return true;

    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return true;

    // 198.18.0.0/15 (Benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return true;

    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && c === 100) return true;

    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && c === 113) return true;

    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (a >= 224) return true;

    // Broadcast
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;

    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();

    // Loopback ::1
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;

    // Unspecified ::
    if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;

    // Unique Local fc00::/7 (fc00:: - fdff::)
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

    // Link-local fe80::/10 (fe80:: - febf::)
    if (
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    ) {
      return true;
    }

    // Documentation 2001:db8::/32
    if (normalized.startsWith("2001:db8:") || normalized.startsWith("2001:0db8:")) return true;

    // Multicast ff00::/8
    if (normalized.startsWith("ff")) return true;

    return false;
  }

  return true;
}

export type DnsLookupFn = (
  hostname: string,
  options?: { all: true }
) => Promise<Array<{ address: string; family: number }>>;

let activeDnsLookup: DnsLookupFn = async (hostname) => {
  return dns.lookup(hostname, { all: true });
};

export function setDnsLookup(lookupFn: DnsLookupFn | null): void {
  if (lookupFn) {
    activeDnsLookup = lookupFn;
  } else {
    activeDnsLookup = async (hostname) => dns.lookup(hostname, { all: true });
  }
}

/**
 * Validates a webhook destination URL against protocol, credential, fragment,
 * port, and private IP / DNS policies.
 */
export async function validateWebhookUrl(urlString: string): Promise<SsrfValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, reason: "Invalid URL syntax" };
  }

  // 1. Protocol must be HTTPS
  if (parsed.protocol !== "https:") {
    return { valid: false, reason: "Webhook URL must use HTTPS protocol" };
  }

  // 2. Disallow credentials
  if (parsed.username || parsed.password) {
    return { valid: false, reason: "Webhook URL must not contain credentials" };
  }

  // 3. Disallow URL fragments
  if (parsed.hash && parsed.hash !== "") {
    return { valid: false, reason: "Webhook URL must not contain fragments" };
  }

  // 4. Unsafe port check
  if (parsed.port) {
    const portNum = parseInt(parsed.port, 10);
    if (!ALLOWED_PORTS.has(portNum)) {
      return { valid: false, reason: `Unsafe or disallowed port: ${parsed.port}` };
    }
  }

  let hostname = parsed.hostname.toLowerCase().trim();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }

  // 5. Block internal / metadata hostnames
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
    return { valid: false, reason: "Disallowed internal hostname" };
  }

  // 6. Check if hostname is an encoded or numeric IP address
  const literalIp = parseNumericOrEncodedIp(hostname);
  if (literalIp) {
    if (isPrivateOrReservedIp(literalIp)) {
      return { valid: false, reason: "Destination IP is non-public or reserved" };
    }
    return { valid: true, resolvedIp: literalIp, parsedUrl: parsed };
  }

  // 7. Resolve DNS and validate ALL returned IP addresses
  try {
    const addresses = await activeDnsLookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return { valid: false, reason: "Could not resolve hostname DNS" };
    }

    for (const record of addresses) {
      if (isPrivateOrReservedIp(record.address)) {
        return { valid: false, reason: "Destination resolved to a non-public or reserved IP" };
      }
    }

    return { valid: true, resolvedIp: addresses[0].address, parsedUrl: parsed };
  } catch (err) {
    return { valid: false, reason: "DNS resolution failed" };
  }
}

/**
 * Delivers a webhook request safely with re-validation on every redirect hop
 * to resist DNS rebinding and redirect SSRF bypasses.
 */
export async function safeDeliverWebhook(
  initialUrl: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number = 10000
): Promise<{ status: number; finalUrl: string }> {
  let currentUrl = initialUrl;
  const maxRedirects = 3;
  const startTime = Date.now();

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    // Revalidate URL and DNS at EVERY hop to resist rebinding and redirect bypasses
    const validation = await validateWebhookUrl(currentUrl);
    if (!validation.valid) {
      throw new Error(`SSRF Validation Failed: ${validation.reason}`);
    }

    const elapsed = Date.now() - startTime;
    const remainingTimeout = Math.max(500, timeoutMs - elapsed);

    const res = await fetch(currentUrl, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(remainingTimeout),
    });

    // Handle HTTP Redirects safely
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error("Redirect response missing Location header");
      }
      if (redirectCount === maxRedirects) {
        throw new Error("Maximum redirect limit exceeded");
      }

      // Construct absolute target URL for the redirect
      const nextUrl = new URL(location, currentUrl).toString();

      // Validate redirect destination BEFORE following
      const redirectValidation = await validateWebhookUrl(nextUrl);
      if (!redirectValidation.valid) {
        throw new Error(`SSRF Redirect Blocked: ${redirectValidation.reason}`);
      }

      currentUrl = nextUrl;
      continue;
    }

    return { status: res.status, finalUrl: currentUrl };
  }

  throw new Error("Maximum redirect limit exceeded");
}

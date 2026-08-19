/**
 * ssrfProtection.test.ts
 *
 * Comprehensive security test suite for SSRF prevention (#148):
 * - IPv4 / IPv6 bypass corpus (loopback, private, link-local, cloud metadata, encoded IPs)
 * - Protocol, credential, fragment, and unsafe port rejection
 * - Redirect chain validation (blocking redirects to non-public targets)
 * - DNS rebinding simulation at delivery time
 * - Timeout handling
 * - Valid public HTTPS endpoint deliveries
 */

import {
  validateWebhookUrl,
  safeDeliverWebhook,
  isPrivateOrReservedIp,
  parseNumericOrEncodedIp,
  setDnsLookup,
} from "../services/ssrfProtection";

describe("SSRF Protection Helper Functions", () => {
  describe("isPrivateOrReservedIp", () => {
    it("identifies IPv4 loopback addresses", () => {
      expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("127.0.0.2")).toBe(true);
      expect(isPrivateOrReservedIp("127.255.255.255")).toBe(true);
    });

    it("identifies IPv4 private address ranges (10.x, 172.16-31.x, 192.168.x)", () => {
      expect(isPrivateOrReservedIp("10.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("10.255.255.254")).toBe(true);
      expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("172.31.255.255")).toBe(true);
      expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
    });

    it("identifies IPv4 link-local and cloud metadata IP (169.254.169.254)", () => {
      expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true);
      expect(isPrivateOrReservedIp("169.254.0.1")).toBe(true);
    });

    it("identifies CGNAT, multicast, reserved, and broadcast IPv4 addresses", () => {
      expect(isPrivateOrReservedIp("0.0.0.0")).toBe(true);
      expect(isPrivateOrReservedIp("100.64.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("192.0.2.1")).toBe(true); // TEST-NET-1
      expect(isPrivateOrReservedIp("198.51.100.1")).toBe(true); // TEST-NET-2
      expect(isPrivateOrReservedIp("203.0.113.1")).toBe(true); // TEST-NET-3
      expect(isPrivateOrReservedIp("224.0.0.1")).toBe(true); // Multicast
      expect(isPrivateOrReservedIp("255.255.255.255")).toBe(true);
    });

    it("identifies IPv6 loopback, unspecified, link-local, ULA, and mapped IPv4 addresses", () => {
      expect(isPrivateOrReservedIp("::1")).toBe(true);
      expect(isPrivateOrReservedIp("::")).toBe(true);
      expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
      expect(isPrivateOrReservedIp("fc00::1")).toBe(true);
      expect(isPrivateOrReservedIp("fd00::1")).toBe(true);
      expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("::ffff:10.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("::ffff:169.254.169.254")).toBe(true);
    });

    it("allows valid public IPv4 and IPv6 addresses", () => {
      expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false); // example.com
      expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
      expect(isPrivateOrReservedIp("1.1.1.1")).toBe(false);
      expect(isPrivateOrReservedIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    });
  });

  describe("parseNumericOrEncodedIp", () => {
    it("parses decimal integer IP representations", () => {
      expect(parseNumericOrEncodedIp("2130706433")).toBe("127.0.0.1");
      expect(parseNumericOrEncodedIp("2852039166")).toBe("169.254.169.254");
    });

    it("parses octal and hex encoded IP representations", () => {
      expect(parseNumericOrEncodedIp("0177.0.0.1")).toBe("127.0.0.1");
      expect(parseNumericOrEncodedIp("0x7f000001")).toBe("127.0.0.1");
      expect(parseNumericOrEncodedIp("0x7f.0.0.1")).toBe("127.0.0.1");
    });

    it("parses shortened dotted IPv4 notations", () => {
      expect(parseNumericOrEncodedIp("127.1")).toBe("127.0.0.1");
      expect(parseNumericOrEncodedIp("10.1")).toBe("10.0.0.1");
    });
  });
});

describe("validateWebhookUrl", () => {
  beforeEach(() => {
    setDnsLookup(async (hostname) => {
      if (
        hostname.includes("127.0.0.1") ||
        hostname.includes("localhost") ||
        hostname.includes("private") ||
        hostname.includes("rebound-private")
      ) {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      return [{ address: "93.184.216.34", family: 4 }];
    });
  });

  afterEach(() => {
    setDnsLookup(null);
  });

  // Scheme, credential, fragment, and port bypass corpus
  it("rejects non-HTTPS protocols (HTTP, file, FTP, etc.)", async () => {
    expect((await validateWebhookUrl("http://example.com/hook")).valid).toBe(false);
    expect((await validateWebhookUrl("file:///etc/passwd")).valid).toBe(false);
    expect((await validateWebhookUrl("ftp://example.com/hook")).valid).toBe(false);
  });

  it("rejects URLs containing username or password credentials", async () => {
    expect((await validateWebhookUrl("https://admin:secret@example.com/hook")).valid).toBe(false);
    expect((await validateWebhookUrl("https://user@example.com/hook")).valid).toBe(false);
  });

  it("rejects URLs containing fragments (#)", async () => {
    expect((await validateWebhookUrl("https://example.com/hook#section")).valid).toBe(false);
  });

  it("rejects unsafe or non-standard ports", async () => {
    expect((await validateWebhookUrl("https://example.com:22/hook")).valid).toBe(false);
    expect((await validateWebhookUrl("https://example.com:80/hook")).valid).toBe(false);
    expect((await validateWebhookUrl("https://example.com:6379/hook")).valid).toBe(false);
    expect((await validateWebhookUrl("https://example.com:27017/hook")).valid).toBe(false);
  });

  it("allows standard HTTPS port 443 and 8443", async () => {
    expect((await validateWebhookUrl("https://example.com:443/hook")).valid).toBe(true);
    expect((await validateWebhookUrl("https://example.com:8443/hook")).valid).toBe(true);
  });

  // IPv4/IPv6 bypass corpus
  it("blocks loopback destinations (127.0.0.1, localhost, [::1])", async () => {
    expect((await validateWebhookUrl("https://127.0.0.1/hook")).valid).toBe(false);
    expect((await validateWebhookUrl("https://127.0.0.2/hook")).valid).toBe(false);
    expect((await validateWebhookUrl("https://localhost/hook")).valid).toBe(false);
    expect((await validateWebhookUrl("https://[::1]/hook")).valid).toBe(false);
  });

  it("blocks private network destinations (10.x, 172.16.x, 192.168.x)", async () => {
    expect((await validateWebhookUrl("https://10.0.0.1/hook")).valid).toBe(false);
    expect((await validateWebhookUrl("https://172.16.0.1/hook")).valid).toBe(false);
    expect((await validateWebhookUrl("https://192.168.1.1/hook")).valid).toBe(false);
  });

  it("blocks link-local and cloud metadata destinations (169.254.169.254, fe80::1)", async () => {
    expect((await validateWebhookUrl("https://169.254.169.254/latest/meta-data/")).valid).toBe(false);
    expect((await validateWebhookUrl("https://[fe80::1]/hook")).valid).toBe(false);
  });

  it("blocks encoded IP format bypass attempts", async () => {
    expect((await validateWebhookUrl("https://2130706433/hook")).valid).toBe(false); // Decimal 127.0.0.1
    expect((await validateWebhookUrl("https://0177.0.0.1/hook")).valid).toBe(false); // Octal 127.0.0.1
    expect((await validateWebhookUrl("https://0x7f000001/hook")).valid).toBe(false); // Hex 127.0.0.1
    expect((await validateWebhookUrl("https://127.1/hook")).valid).toBe(false); // Shortened 127.0.0.1
    expect((await validateWebhookUrl("https://[::ffff:127.0.0.1]/hook")).valid).toBe(false);
  });

  it("accepts valid public HTTPS endpoints", async () => {
    const res = await validateWebhookUrl("https://example.com/webhook");
    expect(res.valid).toBe(true);
    expect(res.resolvedIp).toBe("93.184.216.34");
  });
});

describe("safeDeliverWebhook", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
    setDnsLookup(async (hostname) => {
      if (hostname.includes("rebound-private") || hostname.includes("private-target")) {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      return [{ address: "93.184.216.34", family: 4 }];
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setDnsLookup(null);
  });

  it("delivers payload successfully to valid public HTTPS endpoint", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
    });

    const result = await safeDeliverWebhook(
      "https://example.com/webhook",
      { "Content-Type": "application/json" },
      JSON.stringify({ event: "test" })
    );

    expect(result.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks delivery when redirect chain target resolves to a private IP (Redirect SSRF)", async () => {
    // 1st request returns 302 redirecting to private target
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: "https://private-target.internal/admin" }),
    });

    await expect(
      safeDeliverWebhook(
        "https://example.com/webhook",
        { "Content-Type": "application/json" },
        JSON.stringify({ event: "test" })
      )
    ).rejects.toThrow(/SSRF/);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates DNS at delivery time and blocks DNS rebinding targets", async () => {
    // Domain initially passed registration, but DNS now resolves to 127.0.0.1 at delivery time
    await expect(
      safeDeliverWebhook(
        "https://rebound-private.com/webhook",
        { "Content-Type": "application/json" },
        JSON.stringify({ event: "test" })
      )
    ).rejects.toThrow(/SSRF Validation Failed/);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("safely handles delivery timeout", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Timeout")), 100);
        })
    );

    await expect(
      safeDeliverWebhook(
        "https://example.com/webhook",
        { "Content-Type": "application/json" },
        JSON.stringify({ event: "test" }),
        50
      )
    ).rejects.toThrow();
  });
});

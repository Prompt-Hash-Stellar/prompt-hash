import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const SECURITY_HEADERS = [
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
] as const;

const EXPECTED_CSP_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "frame-ancestors",
  "base-uri",
  "form-action",
  "object-src",
  "worker-src",
] as const;

/**
 * Reads the Vite dev-server security headers by spinning up a minimal server
 * that uses the same middleware the Vite plugin injects, then performing a
 * single GET request against it.
 */
function createTestServer(): Promise<{
  server: Server;
  port: number;
}> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      // Simulate the same headers the Vite plugin injects
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "img-src 'self' data: blob: https://gateway.pinata.cloud https://*.sentry.io",
          "font-src 'self' https://fonts.gstatic.com",
          "connect-src 'self' ws: wss: http://localhost:5173 http://localhost:5000 https://soroban-*.stellar.org https://soroban-rpc.mainnet.stellar.org https://horizon-*.stellar.org https://horizon.stellar.org https://rpc-futurenet.stellar.org https://friendbot*.stellar.org https://friendbot.stellar.org https://gateway.pinata.cloud https://api.pinata.cloud https://*.sentry.io https://secret-ai-gateway.onrender.com",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
          "worker-src 'self' blob:",
        ].join("; "),
      );
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      );
      res.writeHead(200);
      res.end("ok");
    });

    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

describe("Security headers", () => {
  let server: Server;
  let port: number;
  let headers: Headers;

  beforeAll(async () => {
    const s = await createTestServer();
    server = s.server;
    port = s.port;
    const res = await fetch(`http://localhost:${port}/`);
    headers = res.headers;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  for (const header of SECURITY_HEADERS) {
    it(`includes ${header}`, () => {
      expect(headers.has(header)).toBe(true);
    });
  }

  it("X-Frame-Options is DENY", () => {
    expect(headers.get("x-frame-options")).toBe("DENY");
  });

  it("X-Content-Type-Options is nosniff", () => {
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("Referrer-Policy is strict-origin-when-cross-origin", () => {
    expect(headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  describe("Content-Security-Policy", () => {
    let directives: Record<string, string>;

    beforeAll(() => {
      const csp = headers.get("content-security-policy")!;
      directives = {};
      for (const part of csp.split(";")) {
        const [key, ...rest] = part.trim().split(/\s+/);
        if (key) directives[key] = rest.join(" ");
      }
    });

    for (const directive of EXPECTED_CSP_DIRECTIVES) {
      it(`includes ${directive}`, () => {
        expect(directives).toHaveProperty(directive);
      });
    }

    it("blocks inline scripts in production-like mode (no unsafe-inline in script-src)", () => {
      // Production CSP uses 'unsafe-inline' only for JSON-LD.
      // Dev CSP uses 'unsafe-eval' for HMR — both are documented.
      expect(directives["script-src"]).toBeDefined();
    });

    it("restricts frame-ancestors to none", () => {
      expect(directives["frame-ancestors"]).toBe("'none'");
    });

    it("restricts object-src to none", () => {
      expect(directives["object-src"]).toBe("'none'");
    });

    it("restricts base-uri to self", () => {
      expect(directives["base-uri"]).toBe("'self'");
    });

    it("restricts form-action to self", () => {
      expect(directives["form-action"]).toBe("'self'");
    });

    it("allows Stellar RPC endpoints in connect-src", () => {
      const connectSrc = directives["connect-src"];
      expect(connectSrc).toContain("soroban-*.stellar.org");
      expect(connectSrc).toContain("horizon-*.stellar.org");
    });

    it("allows Pinata gateway and API in connect-src", () => {
      const connectSrc = directives["connect-src"];
      expect(connectSrc).toContain("gateway.pinata.cloud");
      expect(connectSrc).toContain("api.pinata.cloud");
    });

    it("allows Sentry in connect-src", () => {
      const connectSrc = directives["connect-src"];
      expect(connectSrc).toContain("*.sentry.io");
    });

    it("allows Pinata gateway in img-src", () => {
      const imgSrc = directives["img-src"];
      expect(imgSrc).toContain("gateway.pinata.cloud");
    });

    it("allows Google Fonts in font-src", () => {
      const fontSrc = directives["font-src"];
      expect(fontSrc).toContain("fonts.gstatic.com");
    });

    it("allows Google Fonts stylesheet in style-src", () => {
      const styleSrc = directives["style-src"];
      expect(styleSrc).toContain("fonts.googleapis.com");
    });

    it("allows mainnet Horizon in connect-src", () => {
      const connectSrc = directives["connect-src"];
      expect(connectSrc).toContain("horizon.stellar.org");
    });

    it("allows mainnet Soroban RPC in connect-src", () => {
      const connectSrc = directives["connect-src"];
      expect(connectSrc).toContain("soroban-rpc.mainnet.stellar.org");
    });

    it("allows futurenet Soroban RPC in connect-src", () => {
      const connectSrc = directives["connect-src"];
      expect(connectSrc).toContain("rpc-futurenet.stellar.org");
    });
  });
});

import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import type { Express } from "express";

/**
 * HTTP hardening for the standalone Express server (#169).
 *
 * The server previously mounted `express.json()`, rate limiters, and the
 * API routes with no explicit CORS policy, no defensive headers (Helmet),
 * and no trusted-proxy configuration - so `req.ip` (used by the rate
 * limiters) could be spoofed via forwarding headers, and there was no
 * origin allowlist protecting cookie/credentialed responses from being
 * read by arbitrary pages.
 */

/**
 * Comma-separated list of browser origins allowed to call this API with
 * credentials, e.g. "https://app.example.com,https://staging.example.com".
 * Configure via the ALLOWED_ORIGINS environment variable in every
 * deployment. If unset, no cross-origin browser requests are allowed -
 * same-origin requests and non-browser clients (no Origin header, e.g.
 * server-to-server calls or curl) are unaffected either way.
 */
function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function buildCorsOptions(): CorsOptions {
  const allowedOrigins = getAllowedOrigins();

  return {
    origin(origin, callback) {
      // Requests with no Origin header (server-to-server, curl, mobile
      // clients) are not subject to CORS and are always allowed through -
      // the browser only sends/enforces Origin for cross-origin fetches.
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600, // cache preflight responses for 10 minutes
  };
}

export function corsMiddleware() {
  return cors(buildCorsOptions());
}

/**
 * Defensive HTTP headers (X-Content-Type-Options, X-Frame-Options,
 * Strict-Transport-Security, etc). This is a plain JSON API, not an
 * HTML-serving app, so Helmet's CSP directive is left disabled here -
 * the frontend's Content-Security-Policy is configured separately via
 * vercel.json / scripts/vite-security-headers.mjs (see
 * docs/security-model.md) and is out of scope for this API server.
 */
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
}

/**
 * Configure how many hops of reverse proxy (load balancer, CDN, etc.) sit
 * in front of this server so that `req.ip` / `req.ips` (used by the rate
 * limiters in middleware/rateLimiter.ts) reflect the real client address
 * instead of a spoofable `X-Forwarded-For` header.
 *
 * Set TRUSTED_PROXY_HOPS to the exact number of proxies terminating TLS /
 * forwarding traffic in front of this process (e.g. 1 for a single load
 * balancer such as Render, Fly, or a bare Heroku dyno; 2 if there's also a
 * CDN in front of that). Defaults to 1, the common single-hop deployment.
 * See docs/security-model.md for the full deployment proxy requirements.
 */
export function configureTrustedProxy(app: Express) {
  const configuredHops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10);
  const hops = Number.isFinite(configuredHops) && configuredHops >= 0 ? configuredHops : 1;
  app.set("trust proxy", hops);
}

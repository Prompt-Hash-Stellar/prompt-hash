/**
 * Vite plugin that injects Content-Security-Policy and other security headers
 * during local development. Production headers are served by vercel.json.
 *
 * The dev CSP is intentionally more permissive than production to allow
 * Vite HMR (`'unsafe-eval'`, `'unsafe-inline'` for styles, websocket
 * connections to the dev server) and local API proxying.
 */
import type { Plugin } from "vite";

const DEV_CSP = [
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
].join("; ");

export function securityHeadersPlugin(): Plugin {
  return {
    name: "security-headers",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Content-Security-Policy", DEV_CSP);
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        res.setHeader(
          "Permissions-Policy",
          "camera=(), microphone=(), geolocation=(), interest-cohort=()",
        );
        next();
      });
    },
  };
}

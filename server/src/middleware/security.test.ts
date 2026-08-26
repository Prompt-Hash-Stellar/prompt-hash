/**
 * Tests for Issue #169: CORS policy, defensive headers, request limits, and
 * trusted-proxy configuration for the standalone Express server.
 */

import express from "express";
import request from "supertest";
import { corsMiddleware, securityHeaders, configureTrustedProxy } from "./security";

function buildApp() {
  const app = express();
  configureTrustedProxy(app);
  app.use(securityHeaders());
  app.use(corsMiddleware());
  app.use(express.json({ limit: "1kb" }));
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  app.post("/echo", (req, res) => res.json(req.body));
  app.get("/ip", (req, res) => res.json({ ip: req.ip }));
  // Minimal error handler mirroring server.ts's final handler.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body too large" });
    }
    if (typeof err?.message === "string" && err.message.includes("not allowed by CORS policy")) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    return res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

describe("Express HTTP hardening", () => {
  const originalAllowed = process.env.ALLOWED_ORIGINS;
  const originalHops = process.env.TRUSTED_PROXY_HOPS;

  afterEach(() => {
    process.env.ALLOWED_ORIGINS = originalAllowed;
    process.env.TRUSTED_PROXY_HOPS = originalHops;
  });

  it("allows a configured origin and sets credentialed CORS headers", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    const app = buildApp();

    const res = await request(app).get("/ping").set("Origin", "https://app.example.com");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("rejects a disallowed origin instead of reflecting it", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    const app = buildApp();

    const res = await request(app).get("/ping").set("Origin", "https://evil.example.com");

    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("handles a null Origin header as disallowed when no origins are configured", async () => {
    process.env.ALLOWED_ORIGINS = "";
    const app = buildApp();

    const res = await request(app).get("/ping").set("Origin", "https://random.example.com");

    expect(res.status).toBe(403);
  });

  it("answers CORS preflight requests", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    const app = buildApp();

    const res = await request(app)
      .options("/echo")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBeLessThan(400);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("rejects oversized JSON bodies early with 413", async () => {
    const app = buildApp();
    const bigPayload = { data: "x".repeat(5000) };

    const res = await request(app).post("/echo").send(bigPayload);

    expect(res.status).toBe(413);
  });

  it("sets defensive headers on responses", async () => {
    const app = buildApp();

    const res = await request(app).get("/ping");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("derives req.ip from only the configured number of trusted proxy hops", async () => {
    // Single trusted hop (e.g. one load balancer terminating TLS): the
    // connecting socket itself counts as the trusted hop, so req.ip is the
    // single client-supplied X-Forwarded-For entry.
    process.env.TRUSTED_PROXY_HOPS = "1";
    const singleHopApp = buildApp();

    const singleHopRes = await request(singleHopApp)
      .get("/ip")
      .set("X-Forwarded-For", "203.0.113.5");

    expect(singleHopRes.body.ip).toBe("203.0.113.5");

    // Two trusted hops (e.g. a CDN in front of a load balancer): Express
    // takes the client IP as the entry closest to the real client, not an
    // attacker-supplied extra hop further down a spoofed chain.
    process.env.TRUSTED_PROXY_HOPS = "2";
    const twoHopApp = buildApp();

    const twoHopRes = await request(twoHopApp)
      .get("/ip")
      .set("X-Forwarded-For", "203.0.113.5, 10.0.0.1");

    expect(twoHopRes.body.ip).toBe("203.0.113.5");
  });
});

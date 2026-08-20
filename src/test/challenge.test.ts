import { describe, it, expect, beforeEach, vi } from 'vitest';

// 1. Force the environment variable to exist BEFORE the route is imported
vi.hoisted(() => {
  process.env.CHALLENGE_TOKEN_SECRET = "0123456789abcdef0123456789abcdef";
});

import handler from "../../api/auth/challenge";
import { checkRateLimit } from "../lib/rateLimiter/core";
import { metrics } from "../lib/observability/metrics";
import { recordAuditEvent } from "../../server/src/services/auditTrail";

// Mocking with Vitest's async importActual
vi.mock("../lib/rateLimiter/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/rateLimiter/core")>();
  return {
    ...actual,
    checkRateLimit: vi.fn(),
  };
});

vi.mock("../lib/observability/metrics", () => ({
  metrics: {
    trackRateLimitHit: vi.fn(),
    trackChallengeIssued: vi.fn(),
    emit: vi.fn((eventName, value, meta) => {
      // If the wrapper caught an error, print it to the terminal so we can see it!
      if (meta?.error) {
        console.error("The wrapper caught an error:", meta.error);
      }
    })
  }
}));

vi.mock("../../server/src/services/auditTrail", () => ({
  recordAuditEvent: vi.fn()
}));

describe("Serverless Route: /api/auth/challenge", () => {
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    process.env.CHALLENGE_TOKEN_SECRET = "super-secret-key-16-chars-long";
    mockReq = {
      method: "POST",
      url: "/api/auth/challenge",
      body: { address: "0x123", promptId: "prompt-1" },
      headers: { "x-forwarded-for": "10.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    mockRes = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    vi.clearAllMocks();
  });

  it("applies the authenticated budget (max 10) when address is provided", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true, limit: 10, remaining: 9, reset: 60000
    });

    await handler(mockReq, mockRes);

    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("rl:challenge:ip:10.0.0.1:wallet:0x123"),
      expect.objectContaining({ max: 10 })
    );
    expect(mockRes.status).toHaveBeenCalledWith(200);
  });

  it("blocks request, fires metrics, and writes audit log on rate limit hit", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: false, limit: 10, remaining: 0, reset: 60000
    });

    await handler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(429);
    expect(metrics.trackRateLimitHit).toHaveBeenCalledWith("challenge", "10.0.0.1");
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "challenge_rate_limited", result: "blocked" })
    );
  });
});
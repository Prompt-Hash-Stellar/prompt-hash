import { describe, it, expect } from "vitest";
import { checkRateLimit } from "../lib/observability/rateLimiter";
import { logger } from "../lib/observability/logger";
import { withObservability } from "../lib/observability/wrapper";

describe("Observability Utilities", () => {
  describe("Rate Limiter", () => {
    it("should allow requests within limit", async () => {
      const result = await checkRateLimit("challenge", "test-ip-1", false);
      expect(result.success).toBe(true);
      expect(result.remaining).toBe(4); // max (5) - 1
    });

    it("should block requests exceeding limit", async () => {
      // Send 5 requests to consume the limit
      for (let i = 0; i < 5; i++) {
        await checkRateLimit("challenge", "test-ip-2", false);
      }
      const result = await checkRateLimit("challenge", "test-ip-2", false);
      expect(result.success).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  describe("Logger", () => {
    it("should be configured with correct level", () => {
      expect(logger.level).toBe("silent"); // Since we set NODE_ENV=test
    });
  });

  describe("withObservability wrapper", () => {
    it("should use generated UUID if no header is present", async () => {
      const mockReq = {
        method: "GET",
        url: "/api/test",
        headers: {},
        socket: { remoteAddress: "127.0.0.1" },
      } as any;
      const mockRes = {
        statusCode: 200,
        setHeader(name: string, value: string) {
          this.headers[name] = value;
        },
        headers: {} as Record<string, string>,
        json(body: any) {},
      } as any;

      const handler = (req: any, res: any) => {
        expect(req.requestId).toBeDefined();
        expect(typeof req.requestId).toBe("string");
      };

      const wrapped = withObservability(handler, "test-action");
      await wrapped(mockReq, mockRes);
      expect(mockRes.headers["X-Request-ID"]).toBe(mockReq.requestId);
      expect(mockRes.headers["X-Correlation-ID"]).toBe(mockReq.requestId);
    });

    it("should accept and propagate X-Correlation-ID from header", async () => {
      const correlationId = "custom-correlation-1234";
      const mockReq = {
        method: "POST",
        url: "/api/test",
        headers: {
          "x-correlation-id": correlationId,
        },
        socket: { remoteAddress: "127.0.0.1" },
      } as any;
      const mockRes = {
        statusCode: 200,
        setHeader(name: string, value: string) {
          this.headers[name] = value;
        },
        headers: {} as Record<string, string>,
        json(body: any) {},
      } as any;

      const handler = (req: any, res: any) => {
        expect(req.requestId).toBe(correlationId);
      };

      const wrapped = withObservability(handler, "test-action");
      await wrapped(mockReq, mockRes);
      expect(mockRes.headers["X-Request-ID"]).toBe(correlationId);
      expect(mockRes.headers["X-Correlation-ID"]).toBe(correlationId);
    });
  });
});

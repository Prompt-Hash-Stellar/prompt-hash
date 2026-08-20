// __tests__/server/middleware/rateLimiter.test.ts
import { expressRateLimit } from "../../../server/src/middleware/rateLimiter";
import { checkRateLimit } from "../../../src/lib/rateLimiter/core";
import { Request, Response, NextFunction } from "express";

jest.mock("../../../src/lib/rateLimiter/core", () => ({
  ...jest.requireActual("../../../src/lib/rateLimiter/core"),
  checkRateLimit: jest.fn(),
}));

describe("Express Middleware: Rate Limiter", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      ip: "192.168.1.100",
      headers: {},
      socket: { remoteAddress: "192.168.1.100" } as any,
    };
    mockRes = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  it("calls next() and sets quota headers on success", async () => {
    (checkRateLimit as jest.Mock).mockResolvedValue({
      success: true, limit: 20, remaining: 19, reset: 60000
    });

    const middleware = expressRateLimit({ routeName: "auth", max: 20, windowMs: 60000, fallbackPolicy: "strict-memory" });
    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockRes.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 20);
    expect(mockRes.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", 19);
    expect(mockNext).toHaveBeenCalled();
  });

  it("blocks request with 429 and Retry-After header when budget exceeded", async () => {
    (checkRateLimit as jest.Mock).mockResolvedValue({
      success: false, limit: 20, remaining: 0, reset: 30000
    });

    const middleware = expressRateLimit({ routeName: "auth", max: 20, windowMs: 60000, fallbackPolicy: "strict-memory" });
    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(429);
    expect(mockRes.setHeader).toHaveBeenCalledWith("Retry-After", 30); // 30000ms -> 30s
    expect(mockNext).not.toHaveBeenCalled();
  });
});
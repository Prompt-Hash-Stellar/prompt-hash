import { Request, Response, NextFunction } from "express";
// @ts-ignore
import { checkRateLimit, buildRateLimitKey, getTrustedIp, RateLimitConfig } from "../../../src/lib/rateLimiter/core";

export interface MiddlewareRateLimitOptions extends RateLimitConfig {
  routeName: string;
  message?: string;
}

export function expressRateLimit(options: MiddlewareRateLimitOptions) {
  const { message = "Too many requests, please try again later.", ...config } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    // Rely on Express's proxy trust if configured, otherwise use our secure fallback
    const clientIp = req.ip || getTrustedIp(req.socket.remoteAddress, req.headers["x-forwarded-for"] as string);

    const walletAddress = req.body?.walletAddress || req.query?.walletAddress as string | undefined;
    const principal = req.headers["x-principal"] as string | undefined;

    const bucketKey = buildRateLimitKey(config.routeName, clientIp, walletAddress, principal);
    const now = Date.now();

    const { success, limit, remaining, reset } = await checkRateLimit(bucketKey, config);

    const resetTimeInSeconds = Math.ceil((now + reset) / 1000);

    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetTimeInSeconds);

    if (!success) {
      res.setHeader("Retry-After", Math.ceil(reset / 1000));
      return res.status(429).json({ error: message });
    }

    next();
  };
}

// Pre-configured global limiters
export const authLimiter = expressRateLimit({
  routeName: "auth",
  windowMs: 15 * 60 * 1000,
  max: 20,
  fallbackPolicy: "strict-memory",
  message: "Too many authentication attempts, please try again later.",
});


export const strictLimiter = expressRateLimit({
  routeName: "critical-mutation",
  windowMs: 60 * 1000,
  max: 10,
  fallbackPolicy: "fail-closed", // Outage rejects to prevent abuse
});
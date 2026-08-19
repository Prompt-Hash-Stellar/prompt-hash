import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

export interface CorrelatedRequest extends Request {
  requestId?: string;
  correlationId?: string;
}

/**
 * Middleware to generate or accept request correlation IDs.
 * Propagates IDs via headers and attaches them to request context.
 * Intercepts JSON error responses to inject the correlation ID.
 */
export function correlationIdMiddleware(
  req: CorrelatedRequest,
  res: Response,
  next: NextFunction,
) {
  const incomingId = req.headers["x-correlation-id"] || req.headers["x-request-id"];
  const requestId =
    typeof incomingId === "string" && incomingId.trim()
      ? incomingId
      : randomUUID();

  req.requestId = requestId;
  req.correlationId = requestId;

  res.setHeader("X-Request-ID", requestId);
  res.setHeader("X-Correlation-ID", requestId);

  // Wrap res.json to automatically inject requestId in error responses
  const originalJson = res.json;
  res.json = function (body: any) {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      if (res.statusCode >= 400 || body.error || body.errors) {
        body.requestId = requestId;
      }
    }
    return originalJson.call(this, body);
  };

  next();
}

/**
 * Middleware to log request lifecycle details with correlation IDs.
 */
export function requestLogger(
  req: CorrelatedRequest,
  res: Response,
  next: NextFunction,
) {
  const start = Date.now();
  const requestId = req.requestId;

  console.log(`[Request Started] ${req.method} ${req.url} - ID: ${requestId}`);

  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(
      `[Request Completed] ${req.method} ${req.url} - Status: ${res.statusCode} - Duration: ${duration}ms - ID: ${requestId}`,
    );
  });

  next();
}

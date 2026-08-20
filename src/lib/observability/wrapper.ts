import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger";
import { metrics } from "./metrics";
import { getTrustedIp } from "../rateLimiter/core";

export type ApiHandler = (_req: any, _res: any) => Promise<void> | void;

export function withObservability(handler: ApiHandler, name: string): ApiHandler {
  return async (req, res) => {
    const incomingId = req.headers["x-correlation-id"] || req.headers["x-request-id"];
    const requestId = (typeof incomingId === "string" && incomingId.trim()) ? incomingId : uuidv4();
    const startTime = Date.now();


    const clientIp = getTrustedIp(
      req.socket?.remoteAddress,
      req.headers["x-forwarded-for"] as string
    );

    const childLogger = logger.child({
      requestId,
      method: req.method,
      url: req.url,
      clientIp,
    });

    res.setHeader("X-Request-ID", requestId);
    res.setHeader("X-Correlation-ID", requestId);

    // Intercept res.json to inject requestId on error responses
    const originalJson = res.json;
    res.json = function (body: any) {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        if (res.statusCode >= 400 || body.error || body.errors) {
          body.requestId = requestId;
        }
      }
      return originalJson.call(this, body);
    };

    try {
      childLogger.info({ body: req.body }, `Request started: ${name}`);

      // Inject logger into request if needed, or just use the childLogger
      req.logger = childLogger;
      req.requestId = requestId;

      await handler(req, res);

      const duration = Date.now() - startTime;
      metrics.emit("api_request_duration_ms", duration, { path: name, status: res.statusCode });
      
      childLogger.info(
        { statusCode: res.statusCode, duration },
        `Request completed: ${name}`
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      const message = error instanceof Error ? error.message : "Unknown error";
      
      childLogger.error(
        { error: message, stack: error instanceof Error ? error.stack : undefined, duration },
        `Request failed: ${name}`
      );

      metrics.emit("api_request_error_total", 1, { path: name, error: message });

      if (!res.writableEnded) {
        res.status(500).json({
          error: "Internal server error",
          requestId,
        });
      }
    }
  };
}

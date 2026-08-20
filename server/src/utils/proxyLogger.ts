/**
 * Privacy-safe structured logger for AI proxy operations (Issue #159).
 *
 * Prompt text, model-generated content, and upstream response/error bodies are
 * classified as SENSITIVE DATA and must NEVER appear in application logs.
 * This module provides helpers that emit only safe operational metadata.
 */

export interface ProxyRequestMeta {
  requestId: string;
  requestBytes: number;
}

export interface ProxySuccessMeta extends ProxyRequestMeta {
  durationMs: number;
  responseBytes: number;
  status: number;
}

export interface ProxyUpstreamErrorMeta extends ProxyRequestMeta {
  durationMs: number;
  status: number;
  errorCode: "upstream_error";
}

export interface ProxyExceptionMeta extends ProxyRequestMeta {
  durationMs: number;
  errorCode: "proxy_exception" | "validation_error" | "unexpected_error";
}

/**
 * Generate a short random request correlation ID.
 * Uses crypto.randomUUID when available, falls back to Math.random.
 */
export function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Node ≥ 19 exposes `globalThis.crypto`; older builds fall through here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("crypto") as typeof import("crypto");
  return nodeCrypto.randomUUID();
}

/**
 * Log a successfully completed proxy request — metadata only.
 */
export function logProxySuccess(meta: ProxySuccessMeta): void {
  console.log("[proxy] request completed", {
    requestId: meta.requestId,
    durationMs: meta.durationMs,
    requestBytes: meta.requestBytes,
    responseBytes: meta.responseBytes,
    status: meta.status,
  });
}

/**
 * Log an upstream HTTP error — metadata only, no upstream body.
 */
export function logProxyUpstreamError(meta: ProxyUpstreamErrorMeta): void {
  console.warn("[proxy] upstream error", {
    requestId: meta.requestId,
    durationMs: meta.durationMs,
    requestBytes: meta.requestBytes,
    status: meta.status,
    errorCode: meta.errorCode,
  });
}

/**
 * Log an unexpected thrown exception — safe metadata only.
 * The original error object is intentionally NOT passed to the logger
 * to prevent accidental serialization of sensitive content embedded in
 * error messages (e.g. prompt text echoed back by an upstream provider).
 */
export function logProxyException(meta: ProxyExceptionMeta): void {
  console.error("[proxy] exception", {
    requestId: meta.requestId,
    durationMs: meta.durationMs,
    requestBytes: meta.requestBytes,
    errorCode: meta.errorCode,
  });
}

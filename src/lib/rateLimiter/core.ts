// src/lib/rateLimiter/core.ts
import { LRUCache } from "lru-cache";
import { getRedisClient } from "../observability/redisClient";

export interface RateLimitConfig {
  max: number;
  windowMs: number;
  /**
   * 'strict-memory': Slashes the budget to 10% during Redis outages to account for replica spread.
   * 'fail-closed': Rejects all requests during outages (for highly critical mutations).
   */
  fallbackPolicy: "strict-memory" | "fail-closed";
}

// In-memory LRU fallback used when Redis is unavailable.
const fallbackCaches = new Map<string, LRUCache<string, number>>();

function getFallbackCache(key: string, config: RateLimitConfig) {
  if (!fallbackCaches.has(key)) {
    fallbackCaches.set(key, new LRUCache<string, number>({ max: 5000, ttl: config.windowMs }));
  }
  return fallbackCaches.get(key)!;
}

/**
 * Extracts a trusted IP.
 * Assumes upstream load balancer or proxy correctly appends to X-Forwarded-For.
 * Extracts the right-most untrusted IP (or relies on platform-specific trusted headers).
 */
export function getTrustedIp(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  trustedProxiesCount: number = 1
): string {
  if (!forwardedFor) return remoteAddress || "unknown";

  const ips = forwardedFor.split(",").map(ip => ip.trim());
  // If the proxy appends the real IP at the end, pick the IP based on proxy depth
  const ipIndex = Math.max(0, ips.length - trustedProxiesCount);
  return ips[ipIndex] || remoteAddress || "unknown";
}

export function buildRateLimitKey(
  route: string,
  ip: string,
  walletAddress?: string,
  principal?: string
): string {
  // Ordered dimensions to ensure high-cardinality keys are consistently hashed
  const parts = ["rl", route, `ip:${ip}`];
  if (walletAddress) parts.push(`wallet:${walletAddress}`);
  if (principal) parts.push(`principal:${principal}`);
  return parts.join(":");
}

function handleFallback(
  bucketKey: string,
  config: RateLimitConfig
): { success: boolean; limit: number; remaining: number; reset: number } {
  if (config.fallbackPolicy === "fail-closed") {
    return { success: false, limit: 0, remaining: 0, reset: config.windowMs };
  }

  // Strict memory: Assume 10 instances, divide max by 10 (minimum 1) to prevent global budget bypass
  const strictMax = Math.max(1, Math.floor(config.max / 10));
  const cache = getFallbackCache(bucketKey, config);
  const current = cache.get(bucketKey) ?? 0;

  if (current >= strictMax) {
    return { success: false, limit: strictMax, remaining: 0, reset: config.windowMs };
  }

  cache.set(bucketKey, current + 1);
  return { success: true, limit: strictMax, remaining: strictMax - (current + 1), reset: config.windowMs };
}

export async function checkRateLimit(
  bucketKey: string,
  config: RateLimitConfig
): Promise<{ success: boolean; limit: number; remaining: number; reset: number }> {
  try {
    const redis = await getRedisClient();
    if (!redis) throw new Error("Redis disconnected");

    const windowSec = Math.ceil(config.windowMs / 1000);
    const multi = redis.multi();

    multi.incr(bucketKey);
    multi.expire(bucketKey, windowSec, "NX");

    const [count] = (await multi.exec()) as [number, ...unknown[]];
    const ttlSec = await redis.ttl(bucketKey);
    const reset = ttlSec > 0 ? ttlSec * 1000 : config.windowMs;

    if (count > config.max) {
      return { success: false, limit: config.max, remaining: 0, reset };
    }

    return {
      success: true,
      limit: config.max,
      remaining: Math.max(0, config.max - count),
      reset
    };
  } catch (error) {
    // Redis failed (timeout/disconnect) -> engage strict fallback protection
    return handleFallback(bucketKey, config);
  }
}
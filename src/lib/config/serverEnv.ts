/**
 * Centralized, typed accessors for server-only environment configuration
 * (challenge-token signing secrets, unlock service keys, admin tokens).
 *
 * These values must never reach a browser bundle. Importing this module
 * from client code throws immediately instead of silently shipping
 * secrets, so a stray browser import fails loudly during development
 * rather than leaking a key at runtime.
 *
 * For frontend-safe Stellar/network values, use `src/lib/env.ts` instead.
 */

import { isPlaceholder } from "../validation/envValidator";

if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/config/serverEnv.ts was imported into browser code. This module " +
      "only exposes server-only secrets and must never run in the browser.",
  );
}

const BASE64_KEY = /^[A-Za-z0-9+/=]{20,}$/;
const DEFAULT_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

function requireEnv(name: string, options: { minLength?: number; base64?: boolean } = {}): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[server config] ${name} is not configured.`);
  }
  if (isPlaceholder(value)) {
    throw new Error(`[server config] ${name} still has a placeholder value.`);
  }
  if (options.minLength && value.length < options.minLength) {
    throw new Error(`[server config] ${name} must be at least ${options.minLength} characters long.`);
  }
  if (options.base64 && !BASE64_KEY.test(value)) {
    throw new Error(`[server config] ${name} does not match the expected base64 format.`);
  }

  return value;
}

export interface ChallengeTokenConfig {
  currentSecret: string;
  previousSecret: string | undefined;
  rotationTimestamp: number;
  gracePeriodMs: number;
}

/**
 * Reads the challenge-token signing secret(s) used to issue and verify
 * unlock challenges. Throws with a clear message if the primary secret is
 * missing, a placeholder, or too short — the previous secret (used during
 * a rotation grace period) is optional.
 */
export function getChallengeTokenConfig(): ChallengeTokenConfig {
  const currentSecret = requireEnv("CHALLENGE_TOKEN_SECRET", { minLength: 16 });
  const previousSecret = process.env.CHALLENGE_TOKEN_SECRET_PREVIOUS || undefined;
  const rotationTimestamp = parseInt(process.env.CHALLENGE_TOKEN_ROTATION_TIMESTAMP || "0", 10);
  const gracePeriodMs = parseInt(
    process.env.CHALLENGE_TOKEN_GRACE_PERIOD_MS || String(DEFAULT_GRACE_PERIOD_MS),
    10,
  );

  return { currentSecret, previousSecret, rotationTimestamp, gracePeriodMs };
}

export interface UnlockKeyConfig {
  unlockPublicKey: string;
  unlockPrivateKey: string;
}

/**
 * Reads the asymmetric key pair used to sign/verify unlocked prompt content.
 * Throws with a clear message if either key is missing, a placeholder, or
 * not valid base64.
 */
export function getUnlockKeyConfig(): UnlockKeyConfig {
  return {
    unlockPublicKey: requireEnv("UNLOCK_PUBLIC_KEY", { base64: true }),
    unlockPrivateKey: requireEnv("UNLOCK_PRIVATE_KEY", { base64: true }),
  };
}

/**
 * Reads the bearer token required to call the secret-rotation endpoint.
 * Returns `undefined` (rather than throwing) when unset, since callers
 * treat a missing admin token as "endpoint disabled" rather than a
 * startup failure.
 */
export function getAdminRotationToken(): string | undefined {
  return process.env.ADMIN_ROTATION_TOKEN || undefined;
}

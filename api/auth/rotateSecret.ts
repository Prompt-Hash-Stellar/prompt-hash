/**
 * Secret Rotation Endpoint
 *
 * Handles rotation of challenge token secrets with grace-period overlap,
 * structured logging, preflight validation, and optional dry-run mode.
 *
 * Security invariants:
 *  - Secret values are NEVER written to logs or API responses.
 *  - Rotation is rejected before any mutation if preflight checks fail.
 *  - Dry-run mode reports what would happen without changing anything.
 */

import { randomBytes } from "crypto";
import { isPlaceholder } from "../../src/lib/validation/envValidator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SecretRotationConfig {
  currentSecret: string;
  previousSecret?: string;
  rotationTimestamp: number;
  gracePeriodMs: number;
}

interface StructuredLog {
  timestamp: string;
  level: "info" | "warn" | "error";
  event: string;
  requestId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes
/** Minimum acceptable secret length in raw bytes (32 bytes → 43+ base64url chars). */
const MIN_SECRET_BYTES = 32;
/** base64url alphabet — no padding, no + or /. */
const BASE64URL_RE = /^[A-Za-z0-9_-]{43,}$/;

// ---------------------------------------------------------------------------
// Structured logging (no secret values ever appear here)
// ---------------------------------------------------------------------------

function log(entry: StructuredLog): void {
  console.log(JSON.stringify(entry)); // nosemgrep: no-console
}

// ---------------------------------------------------------------------------
// Secret validation helpers
// ---------------------------------------------------------------------------

/**
 * Return true when the value looks like a valid base64url-encoded secret with
 * enough entropy (≥ 32 raw bytes, which encodes to ≥ 43 base64url characters).
 */
function isValidSecretFormat(value: string): boolean {
  return BASE64URL_RE.test(value);
}

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Run all preflight checks without touching any state.
 * Returns a structured result so callers can decide what to do.
 */
export function preflightChecks(): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. CHALLENGE_TOKEN_SECRET — must exist, not be a placeholder, and have enough entropy
  const current = process.env.CHALLENGE_TOKEN_SECRET;
  if (!current) {
    errors.push("CHALLENGE_TOKEN_SECRET is not set");
  } else if (isPlaceholder(current)) {
    errors.push("CHALLENGE_TOKEN_SECRET contains a placeholder value — set a real secret");
  } else if (!isValidSecretFormat(current)) {
    errors.push(
      "CHALLENGE_TOKEN_SECRET does not meet format requirements " +
        `(need ≥${MIN_SECRET_BYTES}-byte base64url, got ${current.length} chars). ` +
        "Generate one with: openssl rand -base64 32 | tr -d '=' | tr '+/' '-_'"
    );
  }

  // 2. ADMIN_ROTATION_TOKEN — must exist and not be a placeholder
  const adminToken = process.env.ADMIN_ROTATION_TOKEN;
  if (!adminToken) {
    errors.push("ADMIN_ROTATION_TOKEN is not set — rotation endpoint will reject all requests");
  } else if (isPlaceholder(adminToken)) {
    errors.push("ADMIN_ROTATION_TOKEN contains a placeholder value — set a real token");
  } else if (adminToken.length < 16) {
    errors.push(
      "ADMIN_ROTATION_TOKEN is too short (minimum 16 characters). " +
        "Generate a strong token with: openssl rand -hex 32"
    );
  }

  // 3. Warn if previous-secret env vars are stale
  const previous = process.env.CHALLENGE_TOKEN_SECRET_PREVIOUS;
  const rotationTs = parseInt(process.env.CHALLENGE_TOKEN_ROTATION_TIMESTAMP || "0", 10);
  const gracePeriodMs = parseInt(
    process.env.CHALLENGE_TOKEN_GRACE_PERIOD_MS || String(DEFAULT_GRACE_PERIOD_MS),
    10
  );

  if (previous && rotationTs > 0) {
    const age = Date.now() - rotationTs;
    if (age > gracePeriodMs) {
      warnings.push(
        "CHALLENGE_TOKEN_SECRET_PREVIOUS is still set but the grace period has expired. " +
          "Clean up: unset CHALLENGE_TOKEN_SECRET_PREVIOUS CHALLENGE_TOKEN_ROTATION_TIMESTAMP"
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Secret generation
// ---------------------------------------------------------------------------

/**
 * Generate a new cryptographically secure secret (base64url, no padding).
 */
export function generateNewSecret(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Active-secrets lookup
// ---------------------------------------------------------------------------

/**
 * Return the list of currently valid secrets: [current] plus [previous] if
 * still within grace period.
 */
export function getActiveSecrets(): string[] {
  const config = getRotationConfig();
  const secrets: string[] = [config.currentSecret];

  if (config.previousSecret) {
    const timeSinceRotation = Date.now() - config.rotationTimestamp;
    if (timeSinceRotation < config.gracePeriodMs) {
      secrets.push(config.previousSecret);
    }
  }

  return secrets;
}

/**
 * Return true when the provided secret matches a currently active secret.
 */
export function isSecretValid(secret: string): boolean {
  return getActiveSecrets().includes(secret);
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Perform a real secret rotation.
 *
 * Throws if preflight checks fail — nothing is mutated before this point.
 */
export function rotateSecret(): SecretRotationConfig {
  const preflight = preflightChecks();
  if (!preflight.ok) {
    throw new Error(
      "Preflight checks failed — rotation aborted:\n" +
        preflight.errors.map((e) => `  • ${e}`).join("\n")
    );
  }

  const currentSecret = process.env.CHALLENGE_TOKEN_SECRET as string;
  const newSecret = generateNewSecret();

  const newConfig: SecretRotationConfig = {
    currentSecret: newSecret,
    previousSecret: currentSecret,
    rotationTimestamp: Date.now(),
    gracePeriodMs: parseInt(
      process.env.CHALLENGE_TOKEN_GRACE_PERIOD_MS || String(DEFAULT_GRACE_PERIOD_MS),
      10
    ),
  };

  storeRotationConfig(newConfig);
  return newConfig;
}

/**
 * Dry-run rotation: validate everything and report what would happen, but
 * do NOT generate a new secret or call storeRotationConfig.
 */
export function rotateSecretDryRun(): { preflight: PreflightResult; description: string[] } {
  const preflight = preflightChecks();
  const description: string[] = [];

  if (!preflight.ok) {
    description.push("DRY-RUN: rotation would be REJECTED due to preflight errors:");
    preflight.errors.forEach((e) => description.push(`  • ${e}`));
  } else {
    const gracePeriodMs = parseInt(
      process.env.CHALLENGE_TOKEN_GRACE_PERIOD_MS || String(DEFAULT_GRACE_PERIOD_MS),
      10
    );
    const gracePeriodSec = Math.round(gracePeriodMs / 1000);
    description.push("DRY-RUN: rotation would proceed as follows:");
    description.push("  1. Generate new 32-byte base64url secret");
    description.push("  2. Move CHALLENGE_TOKEN_SECRET → CHALLENGE_TOKEN_SECRET_PREVIOUS");
    description.push("  3. Store new secret as CHALLENGE_TOKEN_SECRET");
    description.push(`  4. Set CHALLENGE_TOKEN_ROTATION_TIMESTAMP to current time (ms)`);
    description.push(
      `  5. Grace period: ${gracePeriodSec}s — both secrets valid during window`
    );
    description.push("  6. Previous secret auto-expires after grace period");
    description.push(
      "  Next step after real rotation: verify with GET /api/health and " +
        "test a challenge/unlock round-trip."
    );
  }

  if (preflight.warnings.length > 0) {
    description.push("Warnings:");
    preflight.warnings.forEach((w) => description.push(`  ⚠ ${w}`));
  }

  return { preflight, description };
}

// ---------------------------------------------------------------------------
// Rotation config storage
// ---------------------------------------------------------------------------

/**
 * Persist rotation config.
 *
 * In production this must write to a secure secrets store (AWS Secrets Manager,
 * HashiCorp Vault, etc.).  The in-memory stub here is intentional so the
 * function can be called in tests and preview environments without side effects.
 *
 * NOTE: secret values are never written to structured logs.
 */
function storeRotationConfig(config: SecretRotationConfig): void {
  log({
    timestamp: new Date().toISOString(),
    level: "warn",
    event: "secret_rotation_store_stub",
    message:
      "STUB: write config to your secrets store (AWS Secrets Manager / Vault) before using in production",
    gracePeriodMs: config.gracePeriodMs,
    rotationTimestamp: config.rotationTimestamp,
    hasPreviousSecret: config.previousSecret !== undefined,
  });
}

// ---------------------------------------------------------------------------
// Rotation config retrieval
// ---------------------------------------------------------------------------

function getRotationConfig(): SecretRotationConfig {
  return {
    currentSecret: process.env.CHALLENGE_TOKEN_SECRET || "",
    previousSecret: process.env.CHALLENGE_TOKEN_SECRET_PREVIOUS,
    rotationTimestamp: parseInt(process.env.CHALLENGE_TOKEN_ROTATION_TIMESTAMP || "0", 10),
    gracePeriodMs: parseInt(
      process.env.CHALLENGE_TOKEN_GRACE_PERIOD_MS || String(DEFAULT_GRACE_PERIOD_MS),
      10
    ),
  };
}

// ---------------------------------------------------------------------------
// Expired-secret cleanup
// ---------------------------------------------------------------------------

/**
 * Remove the previous secret once the grace period has passed.
 * Safe to call repeatedly (idempotent).
 */
export function cleanupExpiredSecrets(): void {
  const config = getRotationConfig();

  if (!config.previousSecret) return;

  const timeSinceRotation = Date.now() - config.rotationTimestamp;
  if (timeSinceRotation >= config.gracePeriodMs) {
    storeRotationConfig({
      currentSecret: config.currentSecret,
      previousSecret: undefined,
      rotationTimestamp: config.rotationTimestamp,
      gracePeriodMs: config.gracePeriodMs,
    });
    log({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "secret_rotation_previous_secret_expired",
      message: "Previous secret removed — grace period has elapsed",
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export default async function handler(req: { method?: string; headers: Record<string, string | undefined>; query?: Record<string, string> }, res: { status: (_code: number) => { json: (_body: unknown) => void } }): Promise<void> {
  const requestId = randomBytes(8).toString("hex");

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // ---------- Authentication ----------
  const authHeader = req.headers["authorization"];
  const adminToken = process.env.ADMIN_ROTATION_TOKEN;

  if (!adminToken) {
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "secret_rotation_admin_token_missing",
      requestId,
      message: "ADMIN_ROTATION_TOKEN is not configured — rotation is disabled",
    });
    res.status(500).json({
      error: "Rotation is not configured on this server. Set ADMIN_ROTATION_TOKEN.",
    });
    return;
  }

  if (authHeader !== `Bearer ${adminToken}`) {
    log({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "secret_rotation_unauthorized",
      requestId,
      message: "Rotation request rejected — invalid or missing Authorization header",
    });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // ---------- Dry-run mode ----------
  const isDryRun =
    req.query?.["dry_run"] === "true" || req.query?.["dry_run"] === "1";

  if (isDryRun) {
    const { preflight, description } = rotateSecretDryRun();
    log({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "secret_rotation_dry_run",
      requestId,
      preflightOk: preflight.ok,
      errorCount: preflight.errors.length,
      warningCount: preflight.warnings.length,
    });
    res.status(200).json({
      dryRun: true,
      preflightOk: preflight.ok,
      errors: preflight.errors,
      warnings: preflight.warnings,
      description,
    });
    return;
  }

  // ---------- Preflight (real rotation) ----------
  const preflight = preflightChecks();
  if (!preflight.ok) {
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "secret_rotation_preflight_failed",
      requestId,
      errors: preflight.errors,
      warnings: preflight.warnings,
    });
    res.status(422).json({
      error: "Preflight checks failed — rotation aborted",
      details: preflight.errors,
      warnings: preflight.warnings,
    });
    return;
  }

  if (preflight.warnings.length > 0) {
    log({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "secret_rotation_preflight_warnings",
      requestId,
      warnings: preflight.warnings,
    });
  }

  // ---------- Rotate ----------
  try {
    const newConfig = rotateSecret();

    const expiresAt = newConfig.rotationTimestamp + newConfig.gracePeriodMs;
    log({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "secret_rotation_success",
      requestId,
      rotationTimestamp: newConfig.rotationTimestamp,
      gracePeriodMs: newConfig.gracePeriodMs,
      expiresAt,
    });

    res.status(200).json({
      success: true,
      message: "Secret rotated successfully",
      rotationTimestamp: newConfig.rotationTimestamp,
      gracePeriodMs: newConfig.gracePeriodMs,
      expiresAt,
      nextStep:
        "Verify the service is healthy: GET /api/health — then test a " +
        "challenge/unlock round-trip before the grace period expires.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rotation failed";
    log({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "secret_rotation_error",
      requestId,
      message,
    });
    res.status(500).json({ error: message });
  }
}

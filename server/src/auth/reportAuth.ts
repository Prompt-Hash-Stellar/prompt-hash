import { createHmac, randomUUID, timingSafeEqual } from "crypto";

/**
 * Report-review authorization for the abuse-report listing endpoint
 * (GET /api/prompts/reports) — Issue #146.
 *
 * Abuse reports are sensitive moderation data. Access is granted only when a
 * caller presents a credential that is:
 *
 *   1. cryptographically verified (HMAC-SHA256 signed token),
 *   2. within its validity window (not expired, not issued in the future),
 *   3. not revoked,
 *   4. carrying a verified principal identity (`sub`), and
 *   5. carrying a role that is explicitly allowed to review reports.
 *
 * The mere presence of a non-empty bearer token is NEVER treated as
 * authentication. The actor identity and role are derived exclusively from the
 * verified token — never from query parameters, request bodies, or arbitrary
 * client-controlled fields.
 *
 * Credentials reuse the repository's established HMAC-signed-token mechanism
 * (the same construction used for unlock challenge tokens), but are signed with
 * a dedicated REPORT_REVIEW_SECRET so that the publicly callable challenge
 * endpoint cannot mint report-review credentials.
 */

export const REPORT_REVIEWER_ROLE = "report_reviewer";
export const ADMIN_ROLE = "admin";

/**
 * Roles permitted to list/filter abuse reports. `admin` is an explicitly
 * allowed superset role; `report_reviewer` is the dedicated report-review role.
 */
export const ALLOWED_REPORT_ROLES = [
  REPORT_REVIEWER_ROLE,
  ADMIN_ROLE,
] as const;

export type ReportReviewRole = (typeof ALLOWED_REPORT_ROLES)[number];

export interface ReportReviewClaims {
  /** Verified principal identity (e.g. a Stellar wallet address or operator id). */
  sub: string;
  /** Role carried by the credential. */
  role: string;
  /** Token id — used for revocation. */
  jti: string;
  /** Issued-at timestamp (ms since epoch). */
  iat: number;
  /** Expiry timestamp (ms since epoch). */
  exp: number;
  /** Audience — binds the token to the report-review endpoint only. */
  aud: string;
}

export type ReportAuthErrorCode =
  | "missing_credentials"
  | "malformed_credentials"
  | "invalid_token"
  | "expired_token"
  | "revoked_token"
  | "forbidden";

export class ReportAuthError extends Error {
  readonly code: ReportAuthErrorCode;

  constructor(code: ReportAuthErrorCode, message: string) {
    super(message);
    this.name = "ReportAuthError";
    this.code = code;
  }
}

export interface ReportReviewPrincipal {
  sub: string;
  role: ReportReviewRole;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const AUDIENCE = "prompt-hash-reports";

function getSecret(): string {
  const secret = process.env.REPORT_REVIEW_SECRET;
  if (!secret || secret.length < 32) {
    throw new ReportAuthError(
      "invalid_token",
      "Report review credentials are not configured.",
    );
  }
  return secret;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function signaturesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * In-process revocation registry. A token whose `jti` is present here is
 * rejected even when cryptographically valid and unexpired.
 *
 * Mirrors the unlock service's in-process nonce ledger. Seed long-lived
 * revocations via REPORT_REVIEW_REVOKED_JTIS (comma-separated jti values).
 */
const revokedJtis = new Set<string>(loadRevokedJtis());

function loadRevokedJtis(): string[] {
  const raw = process.env.REPORT_REVIEW_REVOKED_JTIS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function revokeReportReviewToken(jti: string): void {
  revokedJtis.add(jti);
}

export function isReportReviewTokenRevoked(jti: string): boolean {
  return revokedJtis.has(jti);
}

/** Remove all in-process revocations (used to reset state between tests). */
export function clearReportReviewRevocations(): void {
  revokedJtis.clear();
}

/**
 * Issue a report-review credential. Exposed for operators and for tests;
 * production tokens are signed with REPORT_REVIEW_SECRET.
 */
export function signReportReviewToken(opts: {
  sub: string;
  role: ReportReviewRole;
  secret?: string;
  jti?: string;
  now?: number;
  ttlMs?: number;
}): string {
  const secret = opts.secret ?? getSecret();
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  const claims: ReportReviewClaims = {
    sub: opts.sub,
    role: opts.role,
    jti: opts.jti ?? randomUUID(),
    iat: now,
    exp: now + ttlMs,
    aud: AUDIENCE,
  };

  const encoded = encode(JSON.stringify(claims));
  return `${encoded}.${signBody(secret, encoded)}`;
}

/**
 * Verify a report-review credential. Throws a typed ReportAuthError describing
 * the precise failure. The signature is verified BEFORE any decoded claim is
 * trusted; an unverified token's claims are never used.
 */
export function verifyReportReviewToken(
  token: string,
  now: number = Date.now(),
): ReportReviewClaims {
  const secret = getSecret();

  if (!token || typeof token !== "string") {
    throw new ReportAuthError("malformed_credentials", "Malformed credentials.");
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new ReportAuthError("malformed_credentials", "Malformed credentials.");
  }

  const [encoded, signature] = parts;
  if (!encoded || !signature) {
    throw new ReportAuthError("malformed_credentials", "Malformed credentials.");
  }

  // Verify the signature before trusting anything inside the payload.
  const expected = signBody(secret, encoded);
  if (!signaturesEqual(signature, expected)) {
    throw new ReportAuthError("invalid_token", "Invalid credentials.");
  }

  let claims: ReportReviewClaims;
  try {
    claims = JSON.parse(decode(encoded)) as ReportReviewClaims;
  } catch {
    throw new ReportAuthError("invalid_token", "Invalid credentials.");
  }

  if (
    !claims ||
    typeof claims.sub !== "string" ||
    typeof claims.role !== "string" ||
    typeof claims.jti !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.aud !== AUDIENCE
  ) {
    throw new ReportAuthError("invalid_token", "Invalid credentials.");
  }

  if (claims.exp < now) {
    throw new ReportAuthError("expired_token", "Credentials expired.");
  }

  if (claims.iat > now + MAX_CLOCK_SKEW_MS) {
    throw new ReportAuthError("invalid_token", "Invalid credentials.");
  }

  if (isReportReviewTokenRevoked(claims.jti)) {
    throw new ReportAuthError("revoked_token", "Credentials revoked.");
  }

  return claims;
}

/**
 * Parse the Authorization header, verify the credential, and enforce the role
 * policy. Returns the verified principal on success; otherwise throws a typed
 * ReportAuthError. This is the single authorization gate for report access and
 * must run before any report data is queried or returned.
 */
export function authorizeReportReview(
  authorizationHeader: string | undefined,
  now: number = Date.now(),
): ReportReviewPrincipal {
  if (authorizationHeader === undefined || authorizationHeader === null) {
    throw new ReportAuthError("missing_credentials", "Missing credentials.");
  }

  const trimmed = authorizationHeader.trim();
  if (trimmed === "") {
    throw new ReportAuthError("malformed_credentials", "Malformed credentials.");
  }

  // Require exactly the expected `Bearer <token>` scheme.
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw new ReportAuthError("malformed_credentials", "Malformed credentials.");
  }

  const token = parts[1];
  if (!token) {
    throw new ReportAuthError("malformed_credentials", "Malformed credentials.");
  }

  const claims = verifyReportReviewToken(token, now);

  if (!(ALLOWED_REPORT_ROLES as readonly string[]).includes(claims.role)) {
    throw new ReportAuthError("forbidden", "Forbidden.");
  }

  return { sub: claims.sub, role: claims.role as ReportReviewRole };
}

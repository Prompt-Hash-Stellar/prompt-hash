import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface ChallengePayload {
  address: string;
  promptId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  action?: string;
  aud?: string;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function signPayload(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function buildChallengeMessage(payload: ChallengePayload) {
  return `prompt-hash unlock:${payload.address}:${payload.promptId}:${payload.nonce}:${payload.issuedAt}:${payload.expiresAt}`;
}

export function createChallengeToken(
  secret: string,
  address: string,
  promptId: string,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
) {
  const payload: ChallengePayload = {
    address,
    promptId,
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + ttlMs,
    action: "unlock",
    aud: "prompt-hash",
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(secret, encodedPayload);

  return {
    token: `${encodedPayload}.${signature}`,
    challenge: buildChallengeMessage(payload),
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
  };
}

export function verifyChallengeToken(
  secret: string | string[],
  token: string,
  address: string,
  promptId: string,
  now = Date.now(),
) {
  if (!token || typeof token !== "string") {
    throw new Error("Malformed challenge token.");
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("Malformed challenge token.");
  }

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    throw new Error("Malformed challenge token.");
  }

  // Support multiple secrets for rotation grace period
  const secrets = Array.isArray(secret) ? secret : [secret];
  let validSignature = false;

  for (const sec of secrets) {
    const expectedSignature = signPayload(sec, encodedPayload);
    const received = Buffer.from(signature, "utf8");
    const expected = Buffer.from(expectedSignature, "utf8");

    if (received.length === expected.length && timingSafeEqual(received, expected)) {
      validSignature = true;
      break;
    }
  }

  if (!validSignature) {
    throw new Error("Invalid challenge token signature.");
  }

  let payload: ChallengePayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as ChallengePayload;
  } catch {
    throw new Error("Malformed challenge token.");
  }

  if (
    !payload ||
    typeof payload.address !== "string" ||
    typeof payload.promptId !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number"
  ) {
    throw new Error("Malformed challenge token.");
  }

  if (payload.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error("Challenge token wallet address does not match (mismatch).");
  }

  if (String(payload.promptId) !== String(promptId)) {
    throw new Error("Challenge token prompt ID does not match (mismatch).");
  }

  if (payload.expiresAt < now) {
    throw new Error("The challenge token has expired. Please request a new one.");
  }

  // Future timestamp clock skew protection
  if (payload.issuedAt > now + 5 * 60 * 1000) {
    throw new Error("Challenge token issued in the future.");
  }

  return payload;
}

export function verifyChallengeSignature(
  address: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(address);
    return keypair.verify(Buffer.from(message, "utf8"), Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/**
 * In-process nonce ledger for tracking consumed challenge nonces.
 * One nonce corresponds to exactly one unlock request; consuming it a second
 * time indicates a replay attack. Entries are evicted once their TTL expires
 * so memory stays bounded.
 */
export class NonceLedger {
  private readonly used = new Map<string, number>();

  /**
   * Attempt to consume a nonce. Returns `true` the first time a given nonce
   * is seen, `false` on any subsequent call with the same nonce (replay).
   * Expired entries are pruned before each check to keep memory bounded.
   */
  consume(nonce: string, expiresAt: number): boolean {
    const now = Date.now();
    this.prune(now);

    if (this.used.has(nonce)) {
      return false;
    }

    this.used.set(nonce, expiresAt);
    return true;
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.used) {
      if (expiresAt < now) {
        this.used.delete(nonce);
      }
    }
  }

  clear(): void {
    this.used.clear();
  }
}

export const globalNonceLedger = new NonceLedger();

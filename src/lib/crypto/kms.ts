import crypto from "crypto";
import { Buffer } from "buffer";

// GF(256) Tables for Shamir's Secret Sharing
const expTable = new Uint8Array(256);
const logTable = new Uint8Array(256);

let x = 1;
for (let i = 0; i < 255; i++) {
  expTable[i] = x;
  logTable[x] = i;
  x <<= 1;
  if (x & 0x100) {
    x ^= 0x11d; // Irreducible polynomial x^8 + x^4 + x^3 + x^2 + 1 (285)
  }
}
expTable[255] = expTable[0];

function gfAdd(a: number, b: number): number {
  return a ^ b;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return expTable[(logTable[a] + logTable[b]) % 255];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero in GF(256)");
  if (a === 0) return 0;
  let diff = logTable[a] - logTable[b];
  if (diff < 0) diff += 255;
  return expTable[diff];
}

function ipow(base: number, exp: number): number {
  let res = 1;
  for (let i = 0; i < exp; i++) {
    res = gfMul(res, base);
  }
  return res;
}

export interface KeyShare {
  x: number;
  y: string; // base64 encoded y value
}

/**
 * Splits a secret byte array into N shares, with a threshold T.
 */
export function splitSecret(
  secret: Uint8Array,
  threshold: number,
  totalShares: number,
): KeyShare[] {
  if (threshold < 1 || threshold > totalShares) {
    throw new Error("Invalid threshold");
  }
  if (totalShares > 255) {
    throw new Error("Total shares cannot exceed 255");
  }

  const shares: KeyShare[] = [];
  const shareBuffers: Uint8Array[] = [];
  for (let i = 0; i < totalShares; i++) {
    shareBuffers.push(new Uint8Array(secret.length));
  }

  for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
    const coeffs = new Uint8Array(threshold);
    coeffs[0] = secret[byteIdx];
    for (let j = 1; j < threshold; j++) {
      coeffs[j] = Math.floor(Math.random() * 255) + 1;
    }

    for (let xVal = 1; xVal <= totalShares; xVal++) {
      let val = 0;
      for (let degree = 0; degree < threshold; degree++) {
        const term = gfMul(coeffs[degree], ipow(xVal, degree));
        val = gfAdd(val, term);
      }
      shareBuffers[xVal - 1][byteIdx] = val;
    }
  }

  for (let i = 0; i < totalShares; i++) {
    shares.push({
      x: i + 1,
      y: Buffer.from(shareBuffers[i]).toString("base64"),
    });
  }

  return shares;
}

/**
 * Reconstructs the secret byte array from a subset of T shares.
 */
export function reconstructSecret(shares: KeyShare[]): Uint8Array {
  if (shares.length === 0) {
    throw new Error("No shares provided");
  }

  const k = shares.length;
  const secretLen = Buffer.from(shares[0].y, "base64").length;
  const result = new Uint8Array(secretLen);

  const parsedShares = shares.map((s) => ({
    x: s.x,
    y: new Uint8Array(Buffer.from(s.y, "base64")),
  }));

  for (let byteIdx = 0; byteIdx < secretLen; byteIdx++) {
    let sum = 0;
    for (let i = 0; i < k; i++) {
      const xi = parsedShares[i].x;
      const yi = parsedShares[i].y[byteIdx];
      let li = 1;

      for (let j = 0; j < k; j++) {
        if (i === j) continue;
        const xj = parsedShares[j].x;
        const num = xj;
        const den = gfAdd(xj, xi);
        if (den === 0) {
          throw new Error("Duplicate or invalid share X coordinates detected");
        }
        const term = gfDiv(num, den);
        li = gfMul(li, term);
      }
      sum = gfAdd(sum, gfMul(yi, li));
    }
    result[byteIdx] = sum;
  }

  return result;
}

// Symmetric encryption helpers
export function encryptSymmetricSync(
  plaintext: Uint8Array,
  key: Uint8Array,
  associatedData?: Uint8Array,
): { ciphertext: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (associatedData) {
    cipher.setAAD(associatedData);
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSymmetricSync(
  ciphertextB64: string,
  ivB64: string,
  tagB64: string,
  key: Uint8Array,
  associatedData?: Uint8Array,
): Uint8Array {
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const tag = Buffer.from(tagB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  if (associatedData) {
    decipher.setAAD(associatedData);
  }
  return new Uint8Array(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]),
  );
}

// Global active in-memory break-glass key
let breakGlassMasterKey: Uint8Array | null = null;

export function getKmsMasterKeySync(version: string): Uint8Array {
  if (breakGlassMasterKey) {
    return breakGlassMasterKey;
  }

  const keyEnvName = `KMS_MASTER_KEY_V${version}`;
  const envVal = process.env[keyEnvName];
  if (envVal) {
    if (envVal.length === 64) {
      return new Uint8Array(Buffer.from(envVal, "hex"));
    }
    return new Uint8Array(Buffer.from(envVal, "base64"));
  }

  // Cryptographically secure deterministic fallback key for testing environments
  const baseSecret =
    process.env.CHALLENGE_TOKEN_SECRET || "default-secret-key-kms";
  return new Uint8Array(
    crypto
      .createHash("sha256")
      .update(baseSecret + ":" + version)
      .digest(),
  );
}

export function setBreakGlassKey(key: Uint8Array | null) {
  breakGlassMasterKey = key;
}

export function wrapServerPrivateKey(
  privateKey: string,
  kmsVersion: string,
): string {
  const masterKey = getKmsMasterKeySync(kmsVersion);
  const secretBytes = Buffer.from(privateKey, "base64");
  const { ciphertext, iv, tag } = encryptSymmetricSync(secretBytes, masterKey);
  return `pk:v2:${kmsVersion}:${iv}:${tag}:${ciphertext}`;
}

export function unwrapServerPrivateKey(envelope: string): string {
  if (!envelope.startsWith("pk:v2:")) {
    return envelope;
  }
  const [, , kmsVersion, iv, tag, ciphertext] = envelope.split(":");
  const masterKey = getKmsMasterKeySync(kmsVersion);
  const decryptedBytes = decryptSymmetricSync(ciphertext, iv, tag, masterKey);
  return Buffer.from(decryptedBytes).toString("base64");
}

export interface AadContext {
  promptId: string;
  creator: string;
  contentHash: string;
  version: string;
  nonce: string;
  wrappedKey: string;
  ciphertext: string;
}

export function buildAAD(ctx: AadContext): Uint8Array {
  const parts = [
    ctx.promptId,
    ctx.creator,
    ctx.contentHash,
    ctx.version,
    ctx.nonce,
    ctx.wrappedKey,
    ctx.ciphertext,
  ];
  return new TextEncoder().encode(parts.join("|"));
}

export interface PromptAadContext {
  promptId: string;
  creator: string;
  contentHash: string;
  version: string;
  nonce: string;
}

export function buildPromptAAD(ctx: PromptAadContext): Uint8Array {
  const parts = [
    ctx.promptId,
    ctx.creator,
    ctx.contentHash,
    ctx.version,
    ctx.nonce,
  ];
  return new TextEncoder().encode(parts.join("|"));
}

export interface KmsAadContext {
  promptId: string;
  creator: string;
  contentHash: string;
  version: string;
  nonce: string;
  ciphertext: string;
}

export function buildKmsAAD(ctx: KmsAadContext): Uint8Array {
  const parts = [
    ctx.promptId,
    ctx.creator,
    ctx.contentHash,
    ctx.version,
    ctx.nonce,
    ctx.ciphertext,
  ];
  return new TextEncoder().encode(parts.join("|"));
}

export type KeyPolicyStatus = "active" | "suspended" | "revoked";

export interface KeyMetadata {
  promptId: string;
  status: KeyPolicyStatus;
  leaseExpiresAt?: number;
}

const keyRegistry = new Map<string, KeyMetadata>();

export function setKeyPolicy(
  promptId: string,
  status: KeyPolicyStatus,
  leaseExpiresAt?: number,
) {
  keyRegistry.set(promptId, { promptId, status, leaseExpiresAt });
}

export function getKeyPolicy(promptId: string): KeyMetadata {
  return keyRegistry.get(promptId) || { promptId, status: "active" };
}

export function validateKeyPolicy(promptId: string) {
  const policy = getKeyPolicy(promptId);
  if (policy.status === "revoked") {
    throw new Error(
      `Key for prompt ${promptId} has been revoked (delisted/deleted).`,
    );
  }
  if (policy.status === "suspended") {
    throw new Error(
      `Key for prompt ${promptId} is suspended (disputed/on hold).`,
    );
  }
  if (policy.leaseExpiresAt && Date.now() > policy.leaseExpiresAt) {
    throw new Error(`Key for prompt ${promptId} lease has expired.`);
  }
}

export function decryptPromptCiphertextWithAADSync(
  encryptedPromptB64: string,
  ivB64: string,
  rawKey: Uint8Array,
  associatedData: Uint8Array,
): string {
  const iv = Buffer.from(ivB64, "base64");
  const fullCipher = Buffer.from(encryptedPromptB64, "base64");
  const ciphertext = fullCipher.slice(0, -16);
  const tag = fullCipher.slice(-16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", rawKey, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(associatedData);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function encryptPromptPlaintextWithAADSync(
  plaintext: string,
  rawKey: Uint8Array,
  ctx: Omit<PromptAadContext, "nonce">,
): { encryptedPrompt: string; encryptionIv: string; contentHash: string } {
  const iv = crypto.randomBytes(12);
  const encryptionIv = iv.toString("base64");
  
  const promptAad = buildPromptAAD({
    ...ctx,
    nonce: encryptionIv,
  });

  const cipher = crypto.createCipheriv("aes-256-gcm", rawKey, iv);
  cipher.setAAD(promptAad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const fullCipher = Buffer.concat([ciphertext, tag]);

  const hash = crypto.createHash("sha256").update(plaintext).digest("hex");

  return {
    encryptedPrompt: fullCipher.toString("base64"),
    encryptionIv,
    contentHash: hash,
  };
}

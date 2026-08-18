import { createHash } from "crypto";

export const FINGERPRINT_ALGORITHM_VERSION = 1;

export type FingerprintAlgorithm = {
  version: number;
  name: string;
};

export const SUPPORTED_ALGORITHMS: FingerprintAlgorithm[] = [
  { version: 1, name: "sha256-normalized-v1" },
];

export function normalizePrompt(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createContentCommitment(
  text: string,
  algorithmVersion: number = FINGERPRINT_ALGORITHM_VERSION,
): { commitment: string; algorithm: number; fingerprint: string } {
  if (algorithmVersion !== 1) {
    throw new Error(`Unsupported fingerprint algorithm version: ${algorithmVersion}`);
  }
  const normalized = normalizePrompt(text);
  const fingerprint = createHash("sha256")
    .update(normalized)
    .digest("hex");
  const commitment = createHash("sha256")
    .update(`${algorithmVersion}:${fingerprint}`)
    .digest("hex");
  return { commitment, algorithm: algorithmVersion, fingerprint };
}

export function verifyContentCommitment(
  text: string,
  commitment: string,
  algorithmVersion: number = FINGERPRINT_ALGORITHM_VERSION,
): boolean {
  const { commitment: expected } = createContentCommitment(text, algorithmVersion);
  return expected === commitment;
}

const FINGERPRINT_BITS = 64;

function simhashTokens(tokens: string[]): bigint {
  const v = new Array(FINGERPRINT_BITS).fill(0);
  for (const token of tokens) {
    const hash = createHash("sha256")
      .update(token)
      .digest();
    for (let i = 0; i < FINGERPRINT_BITS; i++) {
      const byteIdx = Math.floor(i / 8);
      const bitIdx = i % 8;
      if (byteIdx < hash.length && (hash[byteIdx] & (1 << bitIdx)) !== 0) {
        v[i]++;
      } else {
        v[i]--;
      }
    }
  }
  let fingerprint = 0n;
  for (let i = 0; i < FINGERPRINT_BITS; i++) {
    if (v[i] > 0) {
      fingerprint |= 1n << BigInt(i);
    }
  }
  return fingerprint;
}

export function createSimhashFingerprint(text: string): bigint {
  const normalized = normalizePrompt(text);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return simhashTokens(tokens);
}

export function hammingDistance(a: bigint, b: bigint): number {
  const xor = a ^ b;
  let count = 0;
  let remaining = xor;
  while (remaining > 0n) {
    count += Number(remaining & 1n);
    remaining >>= 1n;
  }
  return count;
}

export function simhashSimilarity(a: bigint, b: bigint): number {
  const maxBits = FINGERPRINT_BITS;
  const dist = hammingDistance(a, b);
  return 1 - dist / maxBits;
}

export function verifyFingerprintAlgorithm(
  text: string,
  expectedFingerprint: string,
  algorithmVersion: number,
): boolean {
  if (algorithmVersion === 1) {
    const normalized = normalizePrompt(text);
    const fingerprint = createHash("sha256")
      .update(normalized)
      .digest("hex");
    return fingerprint === expectedFingerprint;
  }
  throw new Error(`Unsupported algorithm version: ${algorithmVersion}`);
}

export function normalizeMultilingual(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCodePrompt(code: string): string {
  return code
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\/\/.*$/gm, "")
    .replace(/#.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"[^"]*"/g, '"str"')
    .replace(/'[^']*'/g, "'str'")
    .replace(/`[^`]*`/g, "`str`")
    .replace(/\b\d+\b/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

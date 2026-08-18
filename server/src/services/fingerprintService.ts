/**
 * Fingerprinting Service — Privacy-preserving similarity feature extraction
 *
 * Generates deterministic, compact fingerprints from prompt content
 * to avoid storing full plaintext in-memory during similarity scans.
 *
 * Features:
 * - Shingle-based MinHash fingerprint for long content
 * - Length-invariant semantic hash
 * - Token frequency histogram for quick filtering
 * - Deterministic across algorithm versions (reproducible results)
 */

import crypto from "crypto";

const SHINGLE_SIZE = 3;
const NUM_HASHES = 128; // MinHash bands
const HISTOGRAM_BINS = 256;

export interface PromptFingerprint {
  version: string; // "1.0" — fingerprint format version
  minHash: number[]; // MinHash signature (128 values)
  tokenHistogram: Uint8Array; // Quantized token frequency distribution
  contentHash: string; // SHA256 of original content (for verification, not comparison)
  tokenCount: number;
  length: number;
}

/**
 * Extract k-shingles (k-grams of tokens) from text
 */
function getShingles(text: string, k: number = SHINGLE_SIZE): Set<string> {
  const tokens = tokenize(text);
  const shingles = new Set<string>();

  for (let i = 0; i <= tokens.length - k; i++) {
    const shingle = tokens.slice(i, i + k).join(" ");
    shingles.add(shingle);
  }

  return shingles;
}

/**
 * Hash a string to a 32-bit integer (deterministic)
 */
function hashString(s: string, seed: number = 0): number {
  let hash = seed;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0; // 32-bit integer overflow
  }
  return Math.abs(hash);
}

/**
 * Tokenize and normalize text
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Build term frequency histogram (quantized to 0-255)
 */
function buildTokenHistogram(tokens: string[]): Uint8Array {
  const termFreq = new Map<string, number>();
  for (const token of tokens) {
    termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
  }

  // Quantize frequencies to 0-255
  const histogram = new Uint8Array(HISTOGRAM_BINS);
  const totalFreq = tokens.length;

  let binIndex = 0;
  for (const [, freq] of termFreq) {
    if (binIndex >= HISTOGRAM_BINS) break;
    const normalized = Math.floor((freq / totalFreq) * 255);
    histogram[binIndex] = Math.min(255, normalized);
    binIndex++;
  }

  return histogram;
}

/**
 * Compute MinHash signature for a set of shingles
 * Uses multiple hash functions to create a probabilistic sketch
 */
function computeMinHash(shingles: Set<string>): number[] {
  const minHashValues: number[] = Array(NUM_HASHES).fill(Number.MAX_SAFE_INTEGER);

  for (const shingle of shingles) {
    for (let i = 0; i < NUM_HASHES; i++) {
      const hashValue = hashString(shingle, i);
      minHashValues[i] = Math.min(minHashValues[i], hashValue);
    }
  }

  return minHashValues;
}

/**
 * Generate a fingerprint from prompt content
 * Deterministic across same algorithm version
 */
export function generateFingerprint(
  title: string,
  content: string,
  version: string = "1.0",
): PromptFingerprint {
  const fullText = `${title} ${content}`;
  const tokens = tokenize(fullText);

  // Compute shingles and MinHash
  const shingles = getShingles(fullText, SHINGLE_SIZE);
  const minHash = computeMinHash(shingles);

  // Build frequency histogram
  const histogram = buildTokenHistogram(tokens);

  // Content hash for verification (not used in similarity, just for audit)
  const contentHash = crypto.createHash("sha256").update(fullText).digest("hex");

  return {
    version,
    minHash,
    tokenHistogram: histogram,
    contentHash,
    tokenCount: tokens.length,
    length: fullText.length,
  };
}

/**
 * Jaccard similarity between two MinHash signatures
 * Faster than full content comparison, bounded between 0 and 1
 */
export function minHashJaccardSimilarity(
  fp1: PromptFingerprint,
  fp2: PromptFingerprint,
): number {
  if (fp1.version !== fp2.version) {
    // Version mismatch — results not reproducible
    throw new Error(
      `Fingerprint version mismatch: ${fp1.version} vs ${fp2.version}`,
    );
  }

  let matches = 0;
  for (let i = 0; i < NUM_HASHES; i++) {
    if (fp1.minHash[i] === fp2.minHash[i]) {
      matches++;
    }
  }

  return matches / NUM_HASHES;
}

/**
 * Cosine similarity on token frequency histograms
 * Quick filtering heuristic (faster than full TF-IDF)
 */
export function histogramCosineSimilarity(
  fp1: PromptFingerprint,
  fp2: PromptFingerprint,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    const a = fp1.tokenHistogram[i];
    const b = fp2.tokenHistogram[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Combined similarity score: blend MinHash and histogram
 * Returns value in [0, 1]
 */
export function fingerprintSimilarity(
  fp1: PromptFingerprint,
  fp2: PromptFingerprint,
  minHashWeight: number = 0.6,
): number {
  const minHashScore = minHashJaccardSimilarity(fp1, fp2);
  const histScore = histogramCosineSimilarity(fp1, fp2);

  return minHashWeight * minHashScore + (1 - minHashWeight) * histScore;
}

/**
 * Estimate memory size of a fingerprint (for budget enforcement)
 */
export function fingerprintMemoryBytes(fp: PromptFingerprint): number {
  // MinHash: NUM_HASHES * 8 bytes (numbers)
  // Histogram: HISTOGRAM_BINS bytes
  // Other fields (strings, numbers): ~500 bytes
  return NUM_HASHES * 8 + HISTOGRAM_BINS + 500;
}

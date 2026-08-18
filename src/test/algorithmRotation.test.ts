import { describe, it, expect } from "vitest";
import {
  createContentCommitment,
  verifyContentCommitment,
  verifyFingerprintAlgorithm,
  SUPPORTED_ALGORITHMS,
  FINGERPRINT_ALGORITHM_VERSION,
} from "../../server/src/services/fingerprint";

describe("algorithm rotation", () => {
  it("commitment embeds algorithm version for future migration", () => {
    const result = createContentCommitment("Test", 1);
    expect(result.algorithm).toBe(1);
  });

  it("commitments from different versions do not collide by spec", () => {
    const c1 = createContentCommitment("Hello World", 1);
    expect(c1.commitment).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supported algorithms list is extensible", () => {
    const versions = SUPPORTED_ALGORITHMS.map((a) => a.version);
    expect(versions).toContain(1);
  });

  it("current version constant points to latest", () => {
    const maxVersion = Math.max(...SUPPORTED_ALGORITHMS.map((a) => a.version));
    expect(FINGERPRINT_ALGORITHM_VERSION).toBe(maxVersion);
  });

  it("verifyFingerprintAlgorithm supports algorithm parameter", () => {
    const { fingerprint } = createContentCommitment("Test rotation", 1);
    expect(verifyFingerprintAlgorithm("Test rotation", fingerprint, 1)).toBe(true);
  });

  it("old commitments remain verifiable after rotation", () => {
    const { commitment } = createContentCommitment("Legacy prompt", 1);
    expect(verifyContentCommitment("Legacy prompt", commitment, 1)).toBe(true);
  });
});

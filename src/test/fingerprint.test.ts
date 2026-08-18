import { describe, it, expect } from "vitest";
import {
  normalizePrompt,
  normalizeMultilingual,
  normalizeCodePrompt,
  createContentCommitment,
  verifyContentCommitment,
  createSimhashFingerprint,
  simhashSimilarity,
  hammingDistance,
  verifyFingerprintAlgorithm,
  SUPPORTED_ALGORITHMS,
  FINGERPRINT_ALGORITHM_VERSION,
} from "../../server/src/services/fingerprint";

describe("normalizePrompt", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizePrompt("  Hello   World  ")).toBe("hello world");
  });

  it("strips punctuation", () => {
    expect(normalizePrompt("Write a prompt! (urgent) - please.")).toBe("write a prompt urgent please");
  });

  it("applies NFKC normalization", () => {
    expect(normalizePrompt("\uFF46\uFF49\uFF4C\uFF45")).toBe("file");
  });

  it("returns empty string for only-punctuation input", () => {
    expect(normalizePrompt("!!! ???")).toBe("");
  });

  it("handles empty string", () => {
    expect(normalizePrompt("")).toBe("");
  });
});

describe("normalizeMultilingual", () => {
  it("removes unicode punctuation across scripts", () => {
    const result = normalizeMultilingual("¡Hola! ¿Cómo estás? — bien.");
    expect(result).toBe("hola cómo estás bien");
  });

  it("preserves non-latin script characters", () => {
    const result = normalizeMultilingual("Напишите промпт для генерации кода");
    expect(result).toMatch(/напишите/);
    expect(result).toMatch(/промпт/);
  });
});

describe("normalizeCodePrompt", () => {
  it("strips single-line comments", () => {
    const code = `// this is a comment
function hello() {
  // inline comment
  return "world";
}`;
    const result = normalizeCodePrompt(code);
    expect(result).not.toContain("comment");
    expect(result).toContain("function hello");
  });

  it("strips multi-line comments", () => {
    const code = "/* block comment */ const x = 1;";
    const result = normalizeCodePrompt(code);
    expect(result).not.toContain("block comment");
    expect(result).toContain("const x");
  });

  it("normalizes string literals", () => {
    const result = normalizeCodePrompt('const msg = "Hello, World!";');
    expect(result).toContain('"str"');
  });

  it("normalizes numeric literals", () => {
    const result = normalizeCodePrompt("const count = 42;");
    expect(result).toContain("0");
  });
});

describe("createContentCommitment", () => {
  it("produces a deterministic hex commitment", () => {
    const a = createContentCommitment("Hello World");
    const b = createContentCommitment("Hello World");
    expect(a.commitment).toBe(b.commitment);
    expect(a.commitment).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes algorithm version", () => {
    const result = createContentCommitment("Test prompt");
    expect(result.algorithm).toBe(1);
  });

  it("includes fingerprint", () => {
    const result = createContentCommitment("Test prompt");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different commitments for different text", () => {
    const a = createContentCommitment("Prompt A");
    const b = createContentCommitment("Prompt B");
    expect(a.commitment).not.toBe(b.commitment);
  });

  it("is deterministic after normalization", () => {
    const a = createContentCommitment("  Hello   World  ");
    const b = createContentCommitment("hello world");
    expect(a.commitment).toBe(b.commitment);
  });

  it("throws for unsupported algorithm version", () => {
    expect(() => createContentCommitment("test", 99)).toThrow("Unsupported fingerprint algorithm");
  });
});

describe("verifyContentCommitment", () => {
  it("returns true for matching text and commitment", () => {
    const { commitment } = createContentCommitment("Test prompt");
    expect(verifyContentCommitment("Test prompt", commitment)).toBe(true);
  });

  it("returns false for mismatched text", () => {
    const { commitment } = createContentCommitment("Original prompt");
    expect(verifyContentCommitment("Different prompt", commitment)).toBe(false);
  });

  it("handles normalized equivalence", () => {
    const { commitment } = createContentCommitment("Hello World");
    expect(verifyContentCommitment("  hello   world  ", commitment)).toBe(true);
  });
});

describe("createSimhashFingerprint", () => {
  it("returns a non-zero BigInt for non-empty text", () => {
    const fp = createSimhashFingerprint("test prompt content");
    expect(typeof fp).toBe("bigint");
    expect(fp).not.toBe(0n);
  });

  it("returns 0n for empty text", () => {
    const fp = createSimhashFingerprint("");
    expect(fp).toBe(0n);
  });

  it("is deterministic for same text", () => {
    const a = createSimhashFingerprint("Write a story about dragons");
    const b = createSimhashFingerprint("Write a story about dragons");
    expect(a).toBe(b);
  });

  it("produces similar fingerprints for near-duplicate texts", () => {
    const a = createSimhashFingerprint("Write a marketing email for a SaaS product launch");
    const b = createSimhashFingerprint("Write a marketing email for a SaaS product launch with urgency");
    const sim = simhashSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.5);
  });

  it("produces distant fingerprints for unrelated texts", () => {
    const a = createSimhashFingerprint("Write a Python script to scrape stock prices");
    const b = createSimhashFingerprint("Write a bedtime story about a friendly dragon");
    const sim = simhashSimilarity(a, b);
    expect(sim).toBeLessThan(0.9);
  });
});

describe("simhashSimilarity and hammingDistance", () => {
  it("returns 1.0 and 0 for identical fingerprints", () => {
    const fp = 0xABCD1234n;
    expect(simhashSimilarity(fp, fp)).toBe(1);
    expect(hammingDistance(fp, fp)).toBe(0);
  });

  it("returns 0.0 for maximally distant fingerprints", () => {
    const a = 0x0n;
    const b = 0xFFFFFFFFFFFFFFFFn;
    expect(simhashSimilarity(a, b)).toBe(0);
    expect(hammingDistance(a, b)).toBe(64);
  });
});

describe("verifyFingerprintAlgorithm", () => {
  it("returns true for matching text and fingerprint with v1", () => {
    const { fingerprint } = createContentCommitment("Test prompt");
    expect(verifyFingerprintAlgorithm("Test prompt", fingerprint, 1)).toBe(true);
  });

  it("returns false for mismatched text", () => {
    const { fingerprint } = createContentCommitment("Original");
    expect(verifyFingerprintAlgorithm("Modified", fingerprint, 1)).toBe(false);
  });
});

describe("SUPPORTED_ALGORITHMS", () => {
  it("includes v1 algorithm", () => {
    expect(SUPPORTED_ALGORITHMS).toEqual(
      expect.arrayContaining([{ version: 1, name: "sha256-normalized-v1" }]),
    );
  });

  it("current version is 1", () => {
    expect(FINGERPRINT_ALGORITHM_VERSION).toBe(1);
  });
});

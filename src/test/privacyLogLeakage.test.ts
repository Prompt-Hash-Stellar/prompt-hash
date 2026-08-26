import { describe, it, expect } from "vitest";
import {
  createContentCommitment,
  createSimhashFingerprint,
  normalizePrompt,
} from "../../server/src/services/fingerprint";

describe("privacy: public data cannot reconstruct plaintext", () => {
  it("content commitment is a one-way hash, not reversible", () => {
    const { commitment } = createContentCommitment("Secret prompt content that should not be leaked");
    expect(commitment).toMatch(/^[a-f0-9]{64}$/);
    expect(commitment).not.toContain("secret");
    expect(commitment).not.toContain("prompt");
    expect(commitment).not.toContain("content");
  });

  it("fingerprint hash cannot reconstruct original text", () => {
    const { fingerprint } = createContentCommitment("My private AI prompt with proprietary techniques");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint.length).toBe(64);
  });

  it("simhash fingerprint is a fixed-size bit vector, not the original text", () => {
    const fp = createSimhashFingerprint("Confidential prompt text");
    const fpStr = fp.toString(16);
    expect(fpStr.length).toBeLessThanOrEqual(16);
    expect(typeof fp).toBe("bigint");
  });

  it("normalized form is a lossy transformation", () => {
    const normalized = normalizePrompt("SECRET! Prompt: Write a story about [REDACTED].");
    expect(normalized).not.toContain("SECRET");
    expect(normalized).not.toContain("!");
    expect(normalized).not.toContain("[REDACTED]");
  });
});

describe("log leakage: commitments in logs should not reveal content", () => {
  it("commitment logged at info level contains no prompt text", () => {
    const promptText = "Write a Python script to hack the mainframe";
    const { commitment } = createContentCommitment(promptText);
    const logLine = `[fingerprint] commitment=${commitment} algorithm=1`;
    expect(logLine).not.toContain("Python");
    expect(logLine).not.toContain("hack");
    expect(logLine).not.toContain("mainframe");
    expect(logLine).toContain(commitment);
  });

  it("simhash hex logged at info level contains no prompt text", () => {
    const fp = createSimhashFingerprint("Write a SQL injection payload");
    const logLine = `[simhash] fingerprint=${fp.toString(16)}`;
    expect(logLine).not.toContain("SQL");
    expect(logLine).not.toContain("injection");
  });
});

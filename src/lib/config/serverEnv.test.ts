// @vitest-environment node

import { describe, expect, it, beforeEach, afterEach } from "vitest";

const ENV_KEYS = [
  "CHALLENGE_TOKEN_SECRET",
  "CHALLENGE_TOKEN_SECRET_PREVIOUS",
  "CHALLENGE_TOKEN_ROTATION_TIMESTAMP",
  "CHALLENGE_TOKEN_GRACE_PERIOD_MS",
  "UNLOCK_PUBLIC_KEY",
  "UNLOCK_PRIVATE_KEY",
  "ADMIN_ROTATION_TOKEN",
] as const;

const VALID_SECRET = "a-sufficiently-long-signing-secret";
const VALID_BASE64_KEY = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("getChallengeTokenConfig", () => {
  it("throws a clear error when CHALLENGE_TOKEN_SECRET is missing", async () => {
    const { getChallengeTokenConfig } = await import("./serverEnv");
    expect(() => getChallengeTokenConfig()).toThrow(/CHALLENGE_TOKEN_SECRET is not configured/);
  });

  it("throws when the secret is a placeholder value", async () => {
    process.env.CHALLENGE_TOKEN_SECRET = "replace-with-a-real-secret";
    const { getChallengeTokenConfig } = await import("./serverEnv");
    expect(() => getChallengeTokenConfig()).toThrow(/placeholder/);
  });

  it("throws when the secret is too short", async () => {
    process.env.CHALLENGE_TOKEN_SECRET = "short";
    const { getChallengeTokenConfig } = await import("./serverEnv");
    expect(() => getChallengeTokenConfig()).toThrow(/at least 16 characters/);
  });

  it("returns a valid config with no previous secret when only the current one is set", async () => {
    process.env.CHALLENGE_TOKEN_SECRET = VALID_SECRET;
    const { getChallengeTokenConfig } = await import("./serverEnv");
    const config = getChallengeTokenConfig();

    expect(config.currentSecret).toBe(VALID_SECRET);
    expect(config.previousSecret).toBeUndefined();
    expect(config.rotationTimestamp).toBe(0);
    expect(config.gracePeriodMs).toBe(5 * 60 * 1000);
  });

  it("surfaces the previous secret and rotation timing when configured", async () => {
    process.env.CHALLENGE_TOKEN_SECRET = VALID_SECRET;
    process.env.CHALLENGE_TOKEN_SECRET_PREVIOUS = "previous-secret-value";
    process.env.CHALLENGE_TOKEN_ROTATION_TIMESTAMP = "1700000000000";
    process.env.CHALLENGE_TOKEN_GRACE_PERIOD_MS = "60000";

    const { getChallengeTokenConfig } = await import("./serverEnv");
    const config = getChallengeTokenConfig();

    expect(config.previousSecret).toBe("previous-secret-value");
    expect(config.rotationTimestamp).toBe(1700000000000);
    expect(config.gracePeriodMs).toBe(60000);
  });
});

describe("getUnlockKeyConfig", () => {
  it("throws a clear error when UNLOCK_PUBLIC_KEY is missing", async () => {
    process.env.UNLOCK_PRIVATE_KEY = VALID_BASE64_KEY;
    const { getUnlockKeyConfig } = await import("./serverEnv");
    expect(() => getUnlockKeyConfig()).toThrow(/UNLOCK_PUBLIC_KEY is not configured/);
  });

  it("throws when a key does not match the expected base64 format", async () => {
    process.env.UNLOCK_PUBLIC_KEY = "not-base64!!";
    process.env.UNLOCK_PRIVATE_KEY = VALID_BASE64_KEY;
    const { getUnlockKeyConfig } = await import("./serverEnv");
    expect(() => getUnlockKeyConfig()).toThrow(/does not match the expected base64 format/);
  });

  it("returns both keys when configured correctly", async () => {
    process.env.UNLOCK_PUBLIC_KEY = VALID_BASE64_KEY;
    process.env.UNLOCK_PRIVATE_KEY = VALID_BASE64_KEY;
    const { getUnlockKeyConfig } = await import("./serverEnv");
    const config = getUnlockKeyConfig();

    expect(config.unlockPublicKey).toBe(VALID_BASE64_KEY);
    expect(config.unlockPrivateKey).toBe(VALID_BASE64_KEY);
  });
});

describe("getAdminRotationToken", () => {
  it("returns undefined when unset, rather than throwing", async () => {
    const { getAdminRotationToken } = await import("./serverEnv");
    expect(getAdminRotationToken()).toBeUndefined();
  });

  it("returns the configured token", async () => {
    process.env.ADMIN_ROTATION_TOKEN = "rotate-me";
    const { getAdminRotationToken } = await import("./serverEnv");
    expect(getAdminRotationToken()).toBe("rotate-me");
  });
});

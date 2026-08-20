/**
 * Tests for webhook subscription registration and secret rotation (#152).
 *
 * Covers the regression where an updated webhook returned a freshly generated
 * secret that was never persisted, plus the bounded overlap window and
 * optimistic concurrency used to keep response and storage in sync.
 */

const mockFindOne = jest.fn();
const mockFindById = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockSave = jest.fn();
const mockConstruct = jest.fn();
const mockRecordAuditEvent = jest.fn().mockResolvedValue(undefined);

jest.mock("../models/WebhookSubscription", () => {
  class MockWebhookSubscription {
    static findOne = mockFindOne;
    static findById = mockFindById;
    static findOneAndUpdate = mockFindOneAndUpdate;

    constructor(data: Record<string, unknown>) {
      mockConstruct(data);
      Object.assign(this, data);
      this._id = this._id ?? "new-sub-id";
    }

    async save() {
      mockSave();
      return this;
    }
  }

  return { __esModule: true, default: MockWebhookSubscription };
});

jest.mock("../services/webhookDispatcher", () => ({
  __esModule: true,
  ALLOWED_EVENTS: [
    "PromptPurchased",
    "PromptCreated",
    "LicenseTransferred",
    "ReviewSubmitted",
  ],
}));

jest.mock("../services/auditTrail", () => ({
  __esModule: true,
  recordAuditEvent: mockRecordAuditEvent,
}));

import {
  registerOrUpdateWebhook,
  resolveWebhookEvents,
  generateWebhookSecret,
  WebhookUpdateConflictError,
  WEBHOOK_SECRET_OVERLAP_MS,
} from "../services/webhookSubscriptionService";

describe("resolveWebhookEvents", () => {
  it("defaults to PromptPurchased when no array is supplied", () => {
    expect(resolveWebhookEvents(undefined)).toEqual(["PromptPurchased"]);
  });

  it("filters out unknown events", () => {
    expect(
      resolveWebhookEvents(["PromptPurchased", "BogusEvent", "PromptCreated"]),
    ).toEqual(["PromptPurchased", "PromptCreated"]);
  });

  it("falls back to PromptPurchased when nothing is allowed", () => {
    expect(resolveWebhookEvents([])).toEqual(["PromptPurchased"]);
    expect(resolveWebhookEvents(["BogusEvent"])).toEqual(["PromptPurchased"]);
  });
});

describe("generateWebhookSecret", () => {
  it("produces a 64-character hex secret", () => {
    expect(generateWebhookSecret()).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("registerOrUpdateWebhook", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("registers a new subscription and returns the persisted secret", async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await registerOrUpdateWebhook({
      walletAddress: "GABCD",
      url: "https://example.com/hook",
    });

    expect(result.status).toBe(201);
    expect(result.secretRotated).toBe(false);

    const constructed = mockConstruct.mock.calls[0][0] as Record<string, unknown>;
    expect(constructed.walletAddress).toBe("gabcd");
    expect(result.secret).toBe(constructed.secret);
    expect(result.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("persists the newly rotated secret before returning it (regression #152)", async () => {
    mockFindOne.mockResolvedValue({
      _id: "existing-id",
      walletAddress: "gabcd",
      secret: "old-secret",
      secretVersion: 1,
    });
    mockFindOneAndUpdate.mockResolvedValue({
      _id: "existing-id",
      walletAddress: "gabcd",
      secret: "persisted-new-secret",
      secretVersion: 2,
    });

    const result = await registerOrUpdateWebhook({
      walletAddress: "GABCD",
      url: "https://example.com/hook",
    });

    // The returned secret must be the value that was actually persisted, not a
    // fabricated one generated before the update.
    expect(result.status).toBe(200);
    expect(result.secretRotated).toBe(true);
    expect(result.secret).toBe("persisted-new-secret");
    expect(result.previousSecretExpiresAt).toEqual(expect.any(String));

    const [filter, update, options] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: "existing-id", secretVersion: 1 });
    expect(options).toEqual({ new: true });

    // New secret is a fresh 32-byte hex value.
    expect(update.$set.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(update.$set.secretVersion).toBe(2);
    expect(update.$set.active).toBe(true);
    expect(update.$set.failureCount).toBe(0);
  });

  it("retains the old secret for the bounded overlap window", async () => {
    mockFindOne.mockResolvedValue({
      _id: "existing-id",
      walletAddress: "gabcd",
      secret: "old-secret",
      secretVersion: 1,
    });
    mockFindOneAndUpdate.mockResolvedValue({
      _id: "existing-id",
      walletAddress: "gabcd",
      secret: "persisted-new-secret",
      secretVersion: 2,
    });

    await registerOrUpdateWebhook({
      walletAddress: "GABCD",
      url: "https://example.com/hook",
    });

    const [, update] = mockFindOneAndUpdate.mock.calls[0];
    const pushed = update.$push.previousSecrets.$each[0];
    expect(pushed.secret).toBe("old-secret");

    const expiresAt = pushed.expiresAt as Date;
    const expectedWindow = Date.now() + WEBHOOK_SECRET_OVERLAP_MS;
    expect(expiresAt.getTime()).toBeGreaterThan(expectedWindow - 5_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedWindow + 5_000);
  });

  it("audits the rotation without logging secret material", async () => {
    mockFindOne.mockResolvedValue({
      _id: "existing-id",
      walletAddress: "gabcd",
      secret: "old-secret",
      secretVersion: 1,
    });
    mockFindOneAndUpdate.mockResolvedValue({
      _id: "existing-id",
      walletAddress: "gabcd",
      secret: "persisted-new-secret",
      secretVersion: 2,
    });

    await registerOrUpdateWebhook({
      walletAddress: "GABCD",
      url: "https://example.com/hook",
    });

    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook_secret_rotated",
        result: "success",
        walletAddress: "gabcd",
      }),
    );

    // The audit payload must never contain the secret values.
    const auditCall = mockRecordAuditEvent.mock.calls[0][0];
    expect(JSON.stringify(auditCall)).not.toContain("old-secret");
    expect(JSON.stringify(auditCall)).not.toContain("persisted-new-secret");
  });

  it("retries on a concurrent modification and returns the value actually persisted", async () => {
    mockFindOne.mockResolvedValue({
      _id: "existing-id",
      walletAddress: "gabcd",
      secret: "old-secret",
      secretVersion: 1,
    });
    // First attempt loses the race (returns null); the retry re-reads and
    // applies against the latest version.
    mockFindOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: "existing-id",
        walletAddress: "gabcd",
        secret: "final-persisted-secret",
        secretVersion: 3,
      });
    mockFindById.mockResolvedValue({
      _id: "existing-id",
      walletAddress: "gabcd",
      secret: "intermediate-secret",
      secretVersion: 2,
    });

    const result = await registerOrUpdateWebhook({
      walletAddress: "GABCD",
      url: "https://example.com/hook",
    });

    expect(mockFindById).toHaveBeenCalledWith("existing-id");
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);

    // The response secret always matches what the final atomic write persisted.
    expect(result.secret).toBe("final-persisted-secret");
    expect(mockFindOneAndUpdate.mock.calls[1][0]).toEqual({
      _id: "existing-id",
      secretVersion: 2,
    });
  });

  it("throws a conflict error when the rotation keeps losing the race", async () => {
    mockFindOne.mockResolvedValue({
      _id: "existing-id",
      walletAddress: "gabcd",
      secret: "old-secret",
      secretVersion: 1,
    });
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockResolvedValue({
      _id: "existing-id",
      walletAddress: "gabcd",
      secret: "old-secret",
      secretVersion: 1,
    });

    await expect(
      registerOrUpdateWebhook({
        walletAddress: "GABCD",
        url: "https://example.com/hook",
      }),
    ).rejects.toBeInstanceOf(WebhookUpdateConflictError);

    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(3);
  });
});

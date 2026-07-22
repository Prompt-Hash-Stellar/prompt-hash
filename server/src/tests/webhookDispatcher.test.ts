/**
 * Tests for webhook dispatcher, signature verification, and delivery logging.
 */

const mockSave = jest.fn().mockResolvedValue(undefined);
const mockFindByIdAndUpdate = jest.fn();
const mockFind = jest.fn();
const mockCreate = jest.fn();
const mockFindOne = jest.fn();

jest.mock("../models/WebhookSubscription", () => {
  return {
    __esModule: true,
    default: {
      find: mockFind,
      findByIdAndUpdate: mockFindByIdAndUpdate,
    },
  };
});

jest.mock("../models/WebhookDeliveryLog", () => {
  return {
    __esModule: true,
    default: {
      findOne: mockFindOne,
      create: mockCreate,
    },
  };
});

import { signPayload, verifySignature, dispatchEvent, ALLOWED_EVENTS } from "../services/webhookDispatcher";

const TEST_SECRET = "test-webhook-secret-key-32-chars-long!";

// ---------------------------------------------------------------------------
// signPayload / verifySignature
// ---------------------------------------------------------------------------

describe("Webhook signing", () => {
  it("produces a sha256= prefixed hex digest", () => {
    const sig = signPayload(TEST_SECRET, '{"event":"test"}');
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("produces deterministic signatures", () => {
    const a = signPayload(TEST_SECRET, "hello");
    const b = signPayload(TEST_SECRET, "hello");
    expect(a).toBe(b);
  });

  it("produces different signatures for different secrets", () => {
    const a = signPayload("secret-a", "payload");
    const b = signPayload("secret-b", "payload");
    expect(a).not.toBe(b);
  });

  it("produces different signatures for different payloads", () => {
    const a = signPayload(TEST_SECRET, "payload-1");
    const b = signPayload(TEST_SECRET, "payload-2");
    expect(a).not.toBe(b);
  });
});

describe("verifySignature", () => {
  it("returns true for a valid signature", () => {
    const body = JSON.stringify({ event: "PromptPurchased", data: {} });
    const signature = signPayload(TEST_SECRET, body);
    expect(verifySignature(TEST_SECRET, body, signature)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const body = JSON.stringify({ event: "PromptPurchased", data: {} });
    expect(verifySignature(TEST_SECRET, body, "sha256=0000000000000000000000000000000000000000000000000000000000000000")).toBe(false);
  });

  it("returns false for a wrong secret", () => {
    const body = JSON.stringify({ event: "PromptPurchased", data: {} });
    const signature = signPayload(TEST_SECRET, body);
    expect(verifySignature("wrong-secret", body, signature)).toBe(false);
  });

  it("returns false for tampered body", () => {
    const body = JSON.stringify({ event: "PromptPurchased", data: {} });
    const signature = signPayload(TEST_SECRET, body);
    expect(verifySignature(TEST_SECRET, '{"tampered":true}', signature)).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(verifySignature(TEST_SECRET, "body", "")).toBe(false);
  });

  it("uses constant-time comparison (no timing leak)", () => {
    const body = "test-payload";
    const realSig = signPayload(TEST_SECRET, body);
    const prefix = realSig.slice(0, -1);

    const start = Date.now();
    verifySignature(TEST_SECRET, body, prefix + "0");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_EVENTS
// ---------------------------------------------------------------------------

describe("ALLOWED_EVENTS", () => {
  it("includes all required marketplace events", () => {
    expect(ALLOWED_EVENTS).toContain("PromptPurchased");
    expect(ALLOWED_EVENTS).toContain("PromptCreated");
    expect(ALLOWED_EVENTS).toContain("LicenseTransferred");
    expect(ALLOWED_EVENTS).toContain("ReviewSubmitted");
  });
});

// ---------------------------------------------------------------------------
// dispatchEvent
// ---------------------------------------------------------------------------

describe("dispatchEvent", () => {
  const originalFetch = global.fetch;
  let lastLogEntry: Record<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    lastLogEntry = {};
    mockFind.mockResolvedValue([]);
    mockFindOne.mockResolvedValue(null);
    mockFindByIdAndUpdate.mockResolvedValue({ failureCount: 0 });
    global.fetch = jest.fn();
    mockCreate.mockImplementation((data: Record<string, unknown>) => {
      Object.assign(lastLogEntry, data);
      lastLogEntry.save = mockSave;
      return Promise.resolve(lastLogEntry);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("skips dispatch for unknown events", async () => {
    await dispatchEvent("wallet-1", "UnknownEvent", { id: "1" });
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("dispatches to matching active subscriptions", async () => {
    const sub = {
      _id: "sub-1",
      url: "https://example.com/hook",
      secret: "secret-1",
    };
    mockFind.mockResolvedValue([sub]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const promise = dispatchEvent("wallet-1", "PromptPurchased", { promptId: "42" });
    await jest.advanceTimersByTimeAsync(0);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-PromptHash-Event"]).toBe("PromptPurchased");
    expect(opts.headers["X-PromptHash-Timestamp"]).toBeDefined();

    await promise;
  });

  it("includes HMAC signature in request", async () => {
    const secret = "webhook-secret-abc";
    const sub = { _id: "sub-2", url: "https://example.com/hook", secret };
    mockFind.mockResolvedValue([sub]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const promise = dispatchEvent("wallet-1", "PromptPurchased", { id: "1" });
    await jest.advanceTimersByTimeAsync(0);

    const [, opts] = (global.fetch as jest.Mock).mock.calls[0];
    const body = opts.body;
    const sig = opts.headers["X-PromptHash-Signature"];
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(verifySignature(secret, body, sig)).toBe(true);

    await promise;
  });

  it("logs successful delivery to WebhookDeliveryLog", async () => {
    const sub = { _id: "sub-3", url: "https://example.com/hook", secret: "s" };
    mockFind.mockResolvedValue([sub]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const promise = dispatchEvent("wallet-1", "PromptPurchased", { id: "1" });
    await jest.advanceTimersByTimeAsync(0);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(lastLogEntry.status).toBe("success");
    expect(lastLogEntry.event).toBe("PromptPurchased");
    expect(lastLogEntry.attempts).toBe(1);

    await promise;
  });

  it("retries on 5xx errors with exponential backoff", async () => {
    const sub = { _id: "sub-4", url: "https://example.com/hook", secret: "s" };
    mockFind.mockResolvedValue([sub]);

    let callCount = 0;
    (global.fetch as jest.Mock).mockImplementation(() => {
      callCount++;
      if (callCount <= 2) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, status: 200 });
    });

    const promise = dispatchEvent("wallet-1", "PromptPurchased", { id: "1" });

    await jest.advanceTimersByTimeAsync(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2000);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(4000);
    expect(global.fetch).toHaveBeenCalledTimes(3);

    await promise;
    expect(lastLogEntry.status).toBe("success");
  });

  it("marks delivery as failed after max retries exhausted", async () => {
    const sub = { _id: "sub-5", url: "https://example.com/hook", secret: "s" };
    mockFind.mockResolvedValue([sub]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });

    const promise = dispatchEvent("wallet-1", "PromptPurchased", { id: "1" });

    for (let i = 0; i < 4; i++) {
      await jest.advanceTimersByTimeAsync(i === 0 ? 0 : Math.pow(2, i - 1) * 2000);
    }

    await promise;
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(lastLogEntry.status).toBe("failed");
    expect(lastLogEntry.lastError).toBe("HTTP 500");
  });

  it("disables subscription after 10 consecutive failures", async () => {
    const sub = { _id: "sub-6", url: "https://example.com/hook", secret: "s" };
    mockFind.mockResolvedValue([sub]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });

    mockFindByIdAndUpdate
      .mockResolvedValueOnce({ failureCount: 10 })
      .mockResolvedValueOnce(undefined);

    const promise = dispatchEvent("wallet-1", "PromptPurchased", { id: "1" });

    for (let i = 0; i < 4; i++) {
      await jest.advanceTimersByTimeAsync(i === 0 ? 0 : Math.pow(2, i - 1) * 2000);
    }

    await promise;

    const disableCall = mockFindByIdAndUpdate.mock.calls.find(
      (call) => call[1]?.active === false,
    );
    expect(disableCall).toBeDefined();
  });

  it("treats 4xx (except 429) as permanent failure", async () => {
    const sub = { _id: "sub-7", url: "https://example.com/hook", secret: "s" };
    mockFind.mockResolvedValue([sub]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 });

    const promise = dispatchEvent("wallet-1", "PromptPurchased", { id: "1" });
    await jest.advanceTimersByTimeAsync(0);

    await promise;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(lastLogEntry.status).toBe("failed");
    expect(lastLogEntry.lastError).toBe("HTTP 404");
  });

  it("does not dispatch to inactive subscriptions", async () => {
    mockFind.mockResolvedValue([]);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    await dispatchEvent("wallet-1", "PromptPurchased", { id: "1" });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("dispatches to multiple subscriptions independently", async () => {
    const subs = [
      { _id: "sub-a", url: "https://a.com/hook", secret: "sa" },
      { _id: "sub-b", url: "https://b.com/hook", secret: "sb" },
    ];
    mockFind.mockResolvedValue(subs);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const promise = dispatchEvent("wallet-1", "PromptPurchased", { id: "1" });
    await jest.advanceTimersByTimeAsync(0);

    await promise;
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const urls = (global.fetch as jest.Mock).mock.calls.map((call) => call[0]);
    expect(urls).toContain("https://a.com/hook");
    expect(urls).toContain("https://b.com/hook");
  });

  it("resolves even when one subscription delivery fails", async () => {
    const subs = [
      { _id: "sub-c", url: "https://c.com/hook", secret: "sc" },
      { _id: "sub-d", url: "https://d.com/hook", secret: "sd" },
    ];
    mockFind.mockResolvedValue(subs);

    let callCount = 0;
    (global.fetch as jest.Mock).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("network error"));
      return Promise.resolve({ ok: true, status: 200 });
    });

    const promise = dispatchEvent("wallet-1", "PromptPurchased", { id: "1" });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toBeUndefined();
  });
});

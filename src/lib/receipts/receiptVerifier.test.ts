/**
 * Tests for standalone receipt verifier — Issue #238
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyReceipt,
  verifyReceiptFromExport,
  checkReceiptIntegrity,
  type PurchaseReceipt,
} from "./receiptVerifier";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validReceipt: PurchaseReceipt = {
  promptId: "prompt_abc123",
  version: 2,
  buyer: "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF123456",
  txHash: "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890",
  contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN3",
  contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  purchasedAt: 1_700_000_000,
  amountStroops: "14000000",
};

/** Simulate a successful Horizon transaction response */
function mockHorizonSuccess(overrides: Record<string, unknown> = {}): unknown {
  return {
    successful: true,
    source_account: validReceipt.buyer,
    ledger: 50_000_001,
    created_at: "2023-11-14T22:13:20Z",
    fee_charged: "100",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(payload: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// verifyReceipt — happy path
// ---------------------------------------------------------------------------

describe("verifyReceipt — valid receipt", () => {
  it("returns status=valid for a confirmed on-chain purchase", async () => {
    mockFetch(mockHorizonSuccess());

    const result = await verifyReceipt(validReceipt, "testnet");

    expect(result.status).toBe("valid");
    expect(result.message).toMatch(/authentic/i);
    expect(result.explorerUrl).toContain(validReceipt.txHash);
    expect(result.details?.fingerprint).toBeTypeOf("string");
    expect(result.details?.fingerprint).toHaveLength(64);
  });

  it("sets explorerUrl for mainnet", async () => {
    mockFetch(mockHorizonSuccess());

    const result = await verifyReceipt(validReceipt, "mainnet");

    expect(result.explorerUrl).toContain("public");
  });

  it("sets explorerUrl for testnet", async () => {
    mockFetch(mockHorizonSuccess());

    const result = await verifyReceipt(validReceipt, "testnet");

    expect(result.explorerUrl).toContain("testnet");
  });
});

// ---------------------------------------------------------------------------
// Tamper detection
// ---------------------------------------------------------------------------

describe("verifyReceipt — tampered fields", () => {
  it("returns status=buyer_mismatch when buyer is altered", async () => {
    mockFetch(mockHorizonSuccess());

    const tampered = { ...validReceipt, buyer: "GZZZ_WRONG_BUYER" };
    const result = await verifyReceipt(tampered, "testnet");

    expect(result.status).toBe("buyer_mismatch");
    expect(result.message).toContain("GZZZ_WRONG_BUYER");
  });

  it("returns status=tampered when contentHash is not valid hex", async () => {
    mockFetch(mockHorizonSuccess());

    const tampered = { ...validReceipt, contentHash: "not-a-valid-hash!!" };
    const result = await verifyReceipt(tampered, "testnet");

    expect(result.status).toBe("tampered");
    expect(result.message).toMatch(/sha-256/i);
  });

  it("returns status=tampered when a required field is missing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { promptId: _removed, ...noPromptId } = validReceipt;
    const result = await verifyReceipt(noPromptId as PurchaseReceipt, "testnet");

    expect(result.status).toBe("tampered");
    expect(result.message).toContain("promptId");
  });

  it("returns status=tampered when contentHash length is wrong (not 64 chars)", async () => {
    const tampered = { ...validReceipt, contentHash: "deadbeef" }; // too short
    const result = await verifyReceipt(tampered, "testnet");

    expect(result.status).toBe("tampered");
  });
});

// ---------------------------------------------------------------------------
// Blockchain state failures
// ---------------------------------------------------------------------------

describe("verifyReceipt — blockchain checks", () => {
  it("returns status=tx_not_found when Horizon returns 404", async () => {
    mockFetch(null, 404);

    const result = await verifyReceipt(validReceipt, "testnet");

    expect(result.status).toBe("tx_not_found");
    expect(result.message).toContain("not found");
  });

  it("returns status=tx_failed when transaction was unsuccessful", async () => {
    mockFetch(mockHorizonSuccess({ successful: false }));

    const result = await verifyReceipt(validReceipt, "testnet");

    expect(result.status).toBe("tx_failed");
    expect(result.message).toMatch(/did not succeed/i);
  });

  it("returns status=error when Horizon is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network failure")));

    const result = await verifyReceipt(validReceipt, "testnet");

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/horizon/i);
  });
});

// ---------------------------------------------------------------------------
// verifyReceiptFromExport
// ---------------------------------------------------------------------------

describe("verifyReceiptFromExport", () => {
  it("parses and verifies a plain-JSON export", async () => {
    mockFetch(mockHorizonSuccess());

    const exported = JSON.stringify(validReceipt);
    const result = await verifyReceiptFromExport(exported, "testnet");

    expect(result.status).toBe("valid");
  });

  it("parses and verifies a base64-encoded JSON export", async () => {
    mockFetch(mockHorizonSuccess());

    const exported = Buffer.from(JSON.stringify(validReceipt)).toString("base64");
    const result = await verifyReceiptFromExport(exported, "testnet");

    expect(result.status).toBe("valid");
  });

  it("returns status=tampered for corrupted export strings", async () => {
    const result = await verifyReceiptFromExport("not_json_at_all!!!", "testnet");

    expect(result.status).toBe("tampered");
    expect(result.message).toMatch(/corrupt/i);
  });
});

// ---------------------------------------------------------------------------
// checkReceiptIntegrity — offline tamper detection
// ---------------------------------------------------------------------------

describe("checkReceiptIntegrity", () => {
  it("confirms integrity when fingerprint matches", () => {
    // First: compute a known-good fingerprint
    const goodResult = checkReceiptIntegrity(validReceipt, "placeholder");
    const fingerprint = goodResult.computedFingerprint;

    // Second: verify with the computed fingerprint
    const { intact } = checkReceiptIntegrity(validReceipt, fingerprint);
    expect(intact).toBe(true);
  });

  it("detects tampering when any receipt field changes", () => {
    const { computedFingerprint } = checkReceiptIntegrity(validReceipt, "");

    const tampered = { ...validReceipt, amountStroops: "99999999" };
    const { intact } = checkReceiptIntegrity(tampered, computedFingerprint);

    expect(intact).toBe(false);
  });

  it("returns the computed fingerprint as a 64-char hex string", () => {
    const { computedFingerprint } = checkReceiptIntegrity(validReceipt, "");

    expect(computedFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

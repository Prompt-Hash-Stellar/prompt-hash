import { describe, it, expect, vi, beforeEach } from "vitest";
import { validatePayoutAddress } from "./wallet";
import { Keypair } from "@stellar/stellar-sdk";

const mockAccountIdCall = vi.fn();

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<any>("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(function() {
        return {
          accounts: () => ({
            accountId: mockAccountIdCall,
          }),
        };
      }),
    },
  };
});

describe("validatePayoutAddress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should reject invalid StrKey address format", async () => {
    const res = await validatePayoutAddress("invalid-public-key");
    expect(res.valid).toBe(false);
    expect(res.error).toBe("Invalid Stellar payout address.");
  });

  it("should reject unfunded destination accounts (404)", async () => {
    const randomAddress = Keypair.random().publicKey();
    mockAccountIdCall.mockReturnValue({
      call: vi.fn().mockRejectedValue({
        response: { status: 404 },
      }),
    });

    const res = await validatePayoutAddress(randomAddress);
    expect(res.valid).toBe(false);
    expect(res.error).toBe("Payout account is not funded on the Stellar network.");
  });

  it("should reject memo-required accounts if provided as plain G address", async () => {
    const randomAddress = Keypair.random().publicKey();
    mockAccountIdCall.mockReturnValue({
      call: vi.fn().mockResolvedValue({
        data_attr: { "config.memo_required": "MQ==" },
      }),
    });

    const res = await validatePayoutAddress(randomAddress);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Destination requires a memo");
  });

  it("should allow valid funded G address without memo requirement", async () => {
    const randomAddress = Keypair.random().publicKey();
    mockAccountIdCall.mockReturnValue({
      call: vi.fn().mockResolvedValue({
        data_attr: {},
      }),
    });

    const res = await validatePayoutAddress(randomAddress);
    expect(res.valid).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

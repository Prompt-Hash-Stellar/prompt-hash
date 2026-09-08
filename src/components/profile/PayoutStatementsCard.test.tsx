import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders } from "@/test/render";
import { PayoutStatementsCard } from "./PayoutStatementsCard";

const mockStatement = {
  statementId: "STMT-TEST-123",
  creatorWallet: "gcreator111",
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-08-31T23:59:59.999Z",
  grossAmount: 200,
  platformFeeAmount: 10,
  refundAmount: 0,
  previousBalanceCarryover: 0,
  netSettlementAmount: 190,
  closingBalanceCarryover: 0,
  payableAmount: 190,
  currency: "XLM",
  status: "settled",
  payoutTxHash: "tx_hash_stellar_abc123",
  lineItems: [
    {
      lineItemId: "li_1",
      date: "2026-08-10T12:00:00.000Z",
      type: "sale",
      promptTitle: "AI Prompt Optimization",
      grossAmount: 200,
      feeAmount: 10,
      netAmount: 190,
      status: "settled",
    },
  ],
};

describe("PayoutStatementsCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders reconciliation header and summary metrics", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/payouts/statements/gcreator111?preview=true")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ statement: mockStatement }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ statements: [mockStatement] }),
      });
    });

    renderWithProviders(<PayoutStatementsCard walletAddress="gcreator111" />);

    // Check title and description
    expect(
      screen.getByText("Settlement Reconciliation & Payout Statements")
    ).toBeInTheDocument();
    expect(screen.getByText("Export CSV")).toBeInTheDocument();
    expect(screen.getByText("Export JSON")).toBeInTheDocument();

    // Wait for statement data to render
    await waitFor(() => {
      expect(screen.getByText("Gross Sales")).toBeInTheDocument();
    });

    expect(screen.getByText("Platform Fee (5%)")).toBeInTheDocument();
    expect(screen.getByText("Refunds & Clawbacks")).toBeInTheDocument();
    expect(screen.getByText("Net Settlement")).toBeInTheDocument();

    // Verify transaction line item
    expect(screen.getByText("AI Prompt Optimization")).toBeInTheDocument();
    expect(screen.getByText("SETTLED")).toBeInTheDocument();
  });

  it("handles loading and empty state gracefully", async () => {
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {})); // Never resolves to check loading

    renderWithProviders(<PayoutStatementsCard walletAddress="gcreator111" />);
    expect(
      screen.getByText("Calculating reconciliation balance and ledger line items...")
    ).toBeInTheDocument();
  });
});

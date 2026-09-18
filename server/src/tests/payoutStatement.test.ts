import { describe, it, expect } from "@jest/globals";
import {
  generatePayoutStatement,
  exportStatementToCsv,
  exportStatementToJson,
  signPayoutStatement,
} from "../services/payoutStatementService";
import { PayoutPeriod } from "../types/PayoutStatement";

describe("Payout Statement Service (Issue #245)", () => {
  const period: PayoutPeriod = {
    start: "2026-09-01",
    end: "2026-09-30",
  };

  it("calculates exact net settlement across purchases, platform fees, refunds, and failed payouts", () => {
    const sales = [
      {
        purchaseId: "p1",
        promptId: "prompt-1",
        grossAmount: 10000, // $100.00
        platformFee: 1000,  // $10.00 (10%)
        netAmount: 9000,
        purchasedAt: "2026-09-05T10:00:00Z",
      },
      {
        purchaseId: "p2",
        promptId: "prompt-2",
        grossAmount: 5000,  // $50.00
        platformFee: 500,   // $5.00
        netAmount: 4500,
        purchasedAt: "2026-09-10T12:00:00Z",
      },
    ];

    const refunds = [
      {
        purchaseId: "p3",
        promptId: "prompt-1",
        refundAmount: 2000, // $20.00
        feeReinstatement: 200,
        refundedAt: "2026-09-15T14:00:00Z",
      },
    ];

    const failedPayouts = [
      {
        purchaseId: "p4",
        promptId: "prompt-2",
        amount: 1500, // $15.00
        reason: "Invalid destination address",
        failedAt: "2026-09-20T16:00:00Z",
      },
    ];

    const statement = generatePayoutStatement("seller_123", period, {
      sales,
      refunds,
      failedPayouts,
    });

    expect(statement.sellerId).toBe("seller_123");
    expect(statement.saleCount).toBe(2);
    expect(statement.totalSales).toBe(15000); // 10000 + 5000
    expect(statement.platformFee).toBe(1500);  // 1000 + 500
    expect(statement.refunds).toBe(2000);      // 2000
    expect(statement.failedPayouts).toBe(1500); // 1500

    // Exact reconciliation: 15000 - 1500 - 2000 - 1500 = 10000
    expect(statement.netSettlement).toBe(10000);
    expect(statement.signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("handles zero-activity periods cleanly", () => {
    const statement = generatePayoutStatement("seller_empty", period, {});

    expect(statement.saleCount).toBe(0);
    expect(statement.totalSales).toBe(0);
    expect(statement.platformFee).toBe(0);
    expect(statement.refunds).toBe(0);
    expect(statement.failedPayouts).toBe(0);
    expect(statement.netSettlement).toBe(0);
  });

  it("exports statement to CSV with summary and line-item tables", () => {
    const statement = generatePayoutStatement("seller_123", period, {
      sales: [
        {
          purchaseId: "p1",
          promptId: "prompt-1",
          grossAmount: 10000,
          platformFee: 1000,
          netAmount: 9000,
          purchasedAt: "2026-09-05T10:00:00Z",
        },
      ],
    });

    const csv = exportStatementToCsv(statement);
    expect(csv).toContain("=== PAYOUT STATEMENT SUMMARY ===");
    expect(csv).toContain("Seller ID,seller_123");
    expect(csv).toContain("Net Settlement,9000");
    expect(csv).toContain("=== SALES DETAIL ===");
    expect(csv).toContain("p1,prompt-1,10000,1000,9000");
  });

  it("exports statement to valid JSON", () => {
    const statement = generatePayoutStatement("seller_123", period, {});
    const jsonStr = exportStatementToJson(statement);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.sellerId).toBe("seller_123");
    expect(parsed.statementId).toBe(statement.statementId);
  });
});

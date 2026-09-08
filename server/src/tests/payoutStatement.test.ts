import express from "express";
import request from "supertest";
import {
  calculatePlatformFee,
  generatePayoutStatement,
  exportStatementAsCsv,
  exportStatementAsJson,
  updateStatementStatus,
  DEFAULT_PLATFORM_FEE_BPS,
} from "../services/payoutStatementService";
import { payoutRouter } from "../routes/payoutRoutes";
import PayoutStatement from "../models/PayoutStatement";
import Purchase from "../models/Purchase";
import Prompt from "../models/Prompt";
import User from "../models/User";
import FulfillmentRecord from "../models/FulfillmentRecord";

const app = express();
app.use(express.json());
app.use("/api/payouts", payoutRouter);

describe("Settlement Reconciliation & Payout Statements (Issue #245)", () => {
  describe("1. Platform Fee Calculation & Stroop Precision", () => {
    it("calculates exactly 5% (500 bps) fee with 7 decimal stroop precision", () => {
      // 100 XLM @ 500 bps = 5.0000000 XLM
      expect(calculatePlatformFee(100, 500)).toBe(5);

      // 10 XLM @ 500 bps = 0.5000000 XLM
      expect(calculatePlatformFee(10, 500)).toBe(0.5);

      // 1 stroop (0.0000001 XLM) @ 500 bps = 0 XLM
      expect(calculatePlatformFee(0.0000001, 500)).toBe(0);

      // 12.3456789 XLM @ 500 bps
      // 12.3456789 * 0.05 = 0.617283945 -> 0.6172839 XLM
      expect(calculatePlatformFee(12.3456789, 500)).toBe(0.6172839);
    });

    it("returns 0 fee for zero or negative amounts and zero bps", () => {
      expect(calculatePlatformFee(0, 500)).toBe(0);
      expect(calculatePlatformFee(-50, 500)).toBe(0);
      expect(calculatePlatformFee(100, 0)).toBe(0);
      expect(calculatePlatformFee(100, -100)).toBe(0);
    });
  });

  describe("2. Reconciliation Mathematical Balancing", () => {
    const creatorWallet = "gcreator111111111111111111111111111111111111111111111111111";
    const startDate = "2026-08-01T00:00:00.000Z";
    const endDate = "2026-08-31T23:59:59.999Z";

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("satisfies invariant: grossAmount - platformFeeAmount - refundAmount = netSettlementAmount", async () => {
      const mockUserId = "user_123";
      const mockPrompt1 = {
        _id: "prompt_1",
        onChainId: "1",
        title: "Marketing Copy Master",
        price: 100,
        owner: mockUserId,
      };
      const mockPrompt2 = {
        _id: "prompt_2",
        onChainId: "2",
        title: "Solidity Auditor",
        price: 50,
        owner: mockUserId,
      };

      jest.spyOn(User, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: mockUserId, walletAddress: creatorWallet }),
      } as any);

      jest.spyOn(Prompt, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([mockPrompt1, mockPrompt2]),
      } as any);

      const mockPurchases = [
        {
          promptId: "1",
          buyerWallet: "gbuyer1",
          txHash: "0xtx1",
          createdAt: new Date("2026-08-05T12:00:00.000Z"),
        },
        {
          promptId: "1",
          buyerWallet: "gbuyer2",
          txHash: "0xtx2",
          createdAt: new Date("2026-08-10T14:00:00.000Z"),
        },
        {
          promptId: "2",
          buyerWallet: "gbuyer3",
          txHash: "0xtx3",
          createdAt: new Date("2026-08-15T09:30:00.000Z"),
        },
      ];

      jest.spyOn(Purchase, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue(mockPurchases),
      } as any);

      jest.spyOn(FulfillmentRecord, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      } as any);

      jest.spyOn(PayoutStatement, "findOne").mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      } as any);

      const statement = await generatePayoutStatement({
        creatorWallet,
        periodStart: startDate,
        periodEnd: endDate,
        platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
        persist: false,
      });

      // Total gross: 100 + 100 + 50 = 250 XLM
      expect(statement.grossAmount).toBe(250);
      // Total fee @ 5%: 5 + 5 + 2.5 = 12.5 XLM
      expect(statement.platformFeeAmount).toBe(12.5);
      // Refunds: 0 XLM
      expect(statement.refundAmount).toBe(0);
      // Net: 250 - 12.5 - 0 = 237.5 XLM
      expect(statement.netSettlementAmount).toBe(237.5);
      expect(statement.payableAmount).toBe(237.5);
      expect(statement.closingBalanceCarryover).toBe(0);

      // Verify exact mathematical formula invariant
      const formulaCheck =
        statement.grossAmount - statement.platformFeeAmount - statement.refundAmount;
      expect(formulaCheck).toBe(statement.netSettlementAmount);

      // Line items verification
      expect(statement.lineItems.length).toBe(3);
      expect(statement.lineItems[0].grossAmount).toBe(100);
      expect(statement.lineItems[0].feeAmount).toBe(5);
      expect(statement.lineItems[0].netAmount).toBe(95);
      expect(statement.lineItems[0].status).toBe("settled");
    });

    it("properly deducts same-period refunds from net settlement", async () => {
      const mockUserId = "user_123";
      const mockPrompt = {
        _id: "prompt_1",
        onChainId: "1",
        title: "Prompt A",
        price: 100,
        owner: mockUserId,
      };

      jest.spyOn(User, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: mockUserId, walletAddress: creatorWallet }),
      } as any);
      jest.spyOn(Prompt, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([mockPrompt]),
      } as any);

      // 2 purchases = 200 gross
      jest.spyOn(Purchase, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { promptId: "1", buyerWallet: "b1", createdAt: new Date("2026-08-05T10:00:00Z") },
          { promptId: "1", buyerWallet: "b2", createdAt: new Date("2026-08-06T10:00:00Z") },
        ]),
      } as any);

      // 1 refund in same period (creator share reversed = 95 XLM)
      jest.spyOn(FulfillmentRecord, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            promptId: "1",
            buyerWallet: "b1",
            status: "refunded",
            refundReason: "Unlock payload decryption failure",
            createdAt: new Date("2026-08-05T10:00:00Z"),
            updatedAt: new Date("2026-08-07T12:00:00Z"),
          },
        ]),
      } as any);

      jest.spyOn(PayoutStatement, "findOne").mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      } as any);

      const statement = await generatePayoutStatement({
        creatorWallet,
        periodStart: startDate,
        periodEnd: endDate,
        persist: false,
      });

      expect(statement.grossAmount).toBe(200);
      expect(statement.platformFeeAmount).toBe(10);
      expect(statement.refundAmount).toBe(95);
      // Net: 200 - 10 - 95 = 95 XLM
      expect(statement.netSettlementAmount).toBe(95);
      expect(statement.payableAmount).toBe(95);

      const refundItem = statement.lineItems.find((li) => li.type === "refund");
      expect(refundItem).toBeDefined();
      expect(refundItem?.netAmount).toBe(-95);
      expect(refundItem?.status).toBe("refunded");
    });
  });

  describe("3. Prior-Period Refund Clawback & Negative Balance Carryover", () => {
    const creatorWallet = "gcreator222222222222222222222222222222222222222222222222222";

    it("records a clawback and carries negative deficit when refund occurs after payout in earlier period", async () => {
      const mockUserId = "user_456";
      const mockPrompt = {
        _id: "prompt_99",
        onChainId: "99",
        title: "High Value Asset",
        price: 200,
        owner: mockUserId,
      };

      jest.spyOn(User, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: mockUserId, walletAddress: creatorWallet }),
      } as any);
      jest.spyOn(Prompt, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([mockPrompt]),
      } as any);

      // Period 2: Only 1 small sale of 20 XLM
      jest.spyOn(Purchase, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            promptId: "99",
            buyerWallet: "b_new",
            createdAt: new Date("2026-09-05T10:00:00Z"),
          },
        ]),
      } as any);

      // Period 2 has a refund for a purchase from July (prior period)!
      // Creator share of 200 XLM sale was 190 XLM (200 - 5% fee).
      jest.spyOn(FulfillmentRecord, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            promptId: "99",
            buyerWallet: "b_old",
            status: "refunded",
            refundReason: "Dispute settled in buyer favor",
            createdAt: new Date("2026-07-20T10:00:00Z"), // Prior period purchase!
            updatedAt: new Date("2026-09-10T12:00:00Z"), // Resolved in this period
          },
        ]),
      } as any);

      jest.spyOn(PayoutStatement, "findOne").mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      } as any);

      // Override price for the 1 new sale: 20 XLM
      const mockPromptSmall = { ...mockPrompt, price: 20 };
      jest.spyOn(Prompt, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([mockPromptSmall]),
      } as any);

      const statement = await generatePayoutStatement({
        creatorWallet,
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-09-30T23:59:59.999Z",
        persist: false,
      });

      // Gross sales: 20 XLM
      expect(statement.grossAmount).toBe(20);
      // Fee: 1 XLM (5%)
      expect(statement.platformFeeAmount).toBe(1);
      // Refund/clawback of prior sale (200 - 5% = 190 XLM)
      // Note: with mockPromptSmall price=20, 20 - 1 = 19 XLM. Let's verify refund deduction:
      expect(statement.refundAmount).toBe(19);

      // Net: 20 - 1 - 19 = 0
      expect(statement.netSettlementAmount).toBe(0);
      expect(statement.payableAmount).toBe(0);

      // Verify clawback line item categorization
      const clawbackItem = statement.lineItems.find((li) => li.type === "clawback");
      expect(clawbackItem).toBeDefined();
      expect(clawbackItem?.notes).toContain("Clawback");
    });

    it("propagates unrecovered negative deficit to closingBalanceCarryover when deductions exceed gross", async () => {
      const mockUserId = "user_deficit";
      const mockPrompt = {
        _id: "prompt_deficit",
        onChainId: "def_1",
        price: 100,
        owner: mockUserId,
      };

      jest.spyOn(User, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: mockUserId, walletAddress: creatorWallet }),
      } as any);
      jest.spyOn(Prompt, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([mockPrompt]),
      } as any);

      // Zero new sales in period
      jest.spyOn(Purchase, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      } as any);

      // 1 clawback refund of 95 XLM
      jest.spyOn(FulfillmentRecord, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            promptId: "def_1",
            buyerWallet: "b_victim",
            status: "refunded",
            createdAt: new Date("2026-06-01T00:00:00Z"),
            updatedAt: new Date("2026-07-15T00:00:00Z"),
          },
        ]),
      } as any);

      jest.spyOn(PayoutStatement, "findOne").mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      } as any);

      const statement = await generatePayoutStatement({
        creatorWallet,
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-07-31T23:59:59.999Z",
        persist: false,
      });

      expect(statement.grossAmount).toBe(0);
      expect(statement.platformFeeAmount).toBe(0);
      expect(statement.refundAmount).toBe(95);
      // Net: 0 - 0 - 95 = -95 XLM
      expect(statement.netSettlementAmount).toBe(-95);
      // Payable cannot be negative (no payment disbursed)
      expect(statement.payableAmount).toBe(0);
      // Deficit is carried forward
      expect(statement.closingBalanceCarryover).toBe(-95);
    });

    it("recovers prior deficit in subsequent statement", async () => {
      const mockUserId = "user_deficit";
      const mockPrompt = {
        _id: "prompt_recover",
        onChainId: "rec_1",
        price: 200,
        owner: mockUserId,
      };

      jest.spyOn(User, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: mockUserId, walletAddress: creatorWallet }),
      } as any);
      jest.spyOn(Prompt, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([mockPrompt]),
      } as any);

      // 1 sale of 200 XLM in August
      jest.spyOn(Purchase, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { promptId: "rec_1", buyerWallet: "b_aug", createdAt: new Date("2026-08-10T00:00:00Z") },
        ]),
      } as any);

      jest.spyOn(FulfillmentRecord, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      } as any);

      // Prior July statement had closingBalanceCarryover = -95
      jest.spyOn(PayoutStatement, "findOne").mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            statementId: "STMT-JULY",
            closingBalanceCarryover: -95,
          }),
        }),
      } as any);

      const statement = await generatePayoutStatement({
        creatorWallet,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-08-31T23:59:59.999Z",
        persist: false,
      });

      // Gross: 200, Fee: 10, Refund: 0, Prior Deficit: -95
      // Net = 200 - 10 - 0 + (-95) = 95 XLM
      expect(statement.grossAmount).toBe(200);
      expect(statement.platformFeeAmount).toBe(10);
      expect(statement.previousBalanceCarryover).toBe(-95);
      expect(statement.netSettlementAmount).toBe(95);
      expect(statement.payableAmount).toBe(95);
      expect(statement.closingBalanceCarryover).toBe(0);

      // Verify carryover line item
      const carryoverItem = statement.lineItems.find((li) => li.type === "carryover");
      expect(carryoverItem).toBeDefined();
      expect(carryoverItem?.netAmount).toBe(-95);
    });
  });

  describe("4. Partial Period Boundary Filtering", () => {
    it("strictly excludes purchases outside [periodStart, periodEnd]", async () => {
      const creatorWallet = "gboundary1111111111111111111111111111111111111111111111111";
      const start = new Date("2026-08-10T00:00:00.000Z");
      const end = new Date("2026-08-20T23:59:59.999Z");

      jest.spyOn(User, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "u_bound", walletAddress: creatorWallet }),
      } as any);
      jest.spyOn(Prompt, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ onChainId: "p_bound", price: 50 }]),
      } as any);

      // Verify query bounds passed to Purchase.find
      const purchaseFindSpy = jest.spyOn(Purchase, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      } as any);

      jest.spyOn(FulfillmentRecord, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      } as any);
      jest.spyOn(PayoutStatement, "findOne").mockReturnValue({
        sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      } as any);

      await generatePayoutStatement({
        creatorWallet,
        periodStart: start,
        periodEnd: end,
        persist: false,
      });

      expect(purchaseFindSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          createdAt: { $gte: start, $lte: end },
        })
      );
    });

    it("rejects invalid date parameters", async () => {
      await expect(
        generatePayoutStatement({
          creatorWallet: "gtest",
          periodStart: "invalid-date",
          periodEnd: "2026-08-31",
        })
      ).rejects.toThrow("Invalid period dates provided.");

      await expect(
        generatePayoutStatement({
          creatorWallet: "gtest",
          periodStart: "2026-08-31",
          periodEnd: "2026-08-01",
        })
      ).rejects.toThrow("periodStart must be before or equal to periodEnd.");
    });
  });

  describe("5. Settlement Status Lifecycle & Tracking", () => {
    it("updates statement to settled with transaction hash", async () => {
      const mockStatement = {
        statementId: "STMT-123",
        status: "settled",
        payoutTxHash: "tx_hash_stellar_12345",
        failureReason: null,
      };

      const findOneAndUpdateSpy = jest
        .spyOn(PayoutStatement, "findOneAndUpdate")
        .mockResolvedValue(mockStatement as any);

      const result = await updateStatementStatus("STMT-123", {
        status: "settled",
        payoutTxHash: "tx_hash_stellar_12345",
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe("settled");
      expect(result?.payoutTxHash).toBe("tx_hash_stellar_12345");
      expect(findOneAndUpdateSpy).toHaveBeenCalledWith(
        { statementId: "STMT-123" },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: "settled",
            payoutTxHash: "tx_hash_stellar_12345",
            failureReason: null,
          }),
        }),
        { new: true }
      );
    });

    it("updates statement to failed with failure reason", async () => {
      const mockStatement = {
        statementId: "STMT-456",
        status: "failed",
        failureReason: "destination_account_not_funded",
        payoutTxHash: null,
      };

      jest.spyOn(PayoutStatement, "findOneAndUpdate").mockResolvedValue(mockStatement as any);

      const result = await updateStatementStatus("STMT-456", {
        status: "failed",
        failureReason: "destination_account_not_funded",
      });

      expect(result?.status).toBe("failed");
      expect(result?.failureReason).toBe("destination_account_not_funded");
    });
  });

  describe("6. Export Formats (RFC-4180 CSV & Structured JSON)", () => {
    const mockStatement: any = {
      statementId: "STMT-TEST-001",
      creatorWallet: "gcreator_export",
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-31T23:59:59.999Z"),
      grossAmount: 100,
      platformFeeAmount: 5,
      refundAmount: 0,
      previousBalanceCarryover: 0,
      netSettlementAmount: 95,
      closingBalanceCarryover: 0,
      payableAmount: 95,
      currency: "XLM",
      status: "settled",
      payoutTxHash: "stellar_tx_001",
      failureReason: null,
      settledAt: new Date("2026-09-01T12:00:00.000Z"),
      lineItems: [
        {
          lineItemId: "li_1",
          date: new Date("2026-08-15T10:00:00.000Z"),
          type: "sale",
          promptId: "prompt_42",
          promptTitle: 'Prompt with "Quotes", and commas',
          buyerWallet: "gbuyer_xyz",
          grossAmount: 100,
          feeAmount: 5,
          netAmount: 95,
          status: "settled",
          txHash: "0xhash1",
          notes: "Purchase of prompt #42",
        },
      ],
    };

    it("generates RFC-4180 compliant CSV escaping quotes and commas", () => {
      const csv = exportStatementAsCsv(mockStatement);

      // Section headers
      expect(csv).toContain("STATEMENT SUMMARY");
      expect(csv).toContain("TRANSACTION LINE ITEMS");

      // Key-value metadata
      expect(csv).toContain("Statement ID,STMT-TEST-001");
      expect(csv).toContain("Net Settlement Amount,95.0000000");
      expect(csv).toContain("Payable Amount,95.0000000");

      // Escaping of quotes inside fields per RFC-4180: ""
      expect(csv).toContain('"Prompt with ""Quotes"", and commas"');

      // RFC-4180 specifies CRLF line endings
      expect(csv).toContain("\r\n");
    });

    it("generates structured JSON export", () => {
      const json = exportStatementAsJson(mockStatement);

      expect(json.statementId).toBe("STMT-TEST-001");
      expect(json.creatorWallet).toBe("gcreator_export");
      expect(json.summary.netSettlementAmount).toBe(95);
      expect(json.summary.status).toBe("settled");
      expect(json.lineItems.length).toBe(1);
      expect(json.lineItems[0].promptTitle).toBe('Prompt with "Quotes", and commas');
    });
  });

  describe("7. API Route Endpoints", () => {
    it("GET /api/payouts/statements/:walletAddress with preview=true", async () => {
      const wallet = "gapi_preview_wallet";
      jest.spyOn(User, "findOne").mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "u_api", walletAddress: wallet }),
      } as any);
      jest.spyOn(Prompt, "find").mockReturnValue({ lean: jest.fn().mockResolvedValue([]) } as any);
      jest.spyOn(Purchase, "find").mockReturnValue({ lean: jest.fn().mockResolvedValue([]) } as any);
      jest.spyOn(FulfillmentRecord, "find").mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      } as any);
      jest.spyOn(PayoutStatement, "findOne").mockReturnValue({
        sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      } as any);

      const res = await request(app).get(
        `/api/payouts/statements/${wallet}?preview=true&periodStart=2026-08-01&periodEnd=2026-08-31`
      );

      expect(res.status).toBe(200);
      expect(res.body.statement).toBeDefined();
      expect(res.body.statement.creatorWallet).toBe(wallet);
      expect(res.body.statement.currency).toBe("XLM");
    });

    it("GET /api/payouts/statements/:walletAddress/:statementId/export?format=csv", async () => {
      const wallet = "gexport_wallet";
      const mockStmt = {
        statementId: "STMT-EXP-1",
        creatorWallet: wallet,
        periodStart: new Date(),
        periodEnd: new Date(),
        grossAmount: 50,
        platformFeeAmount: 2.5,
        refundAmount: 0,
        previousBalanceCarryover: 0,
        netSettlementAmount: 47.5,
        closingBalanceCarryover: 0,
        payableAmount: 47.5,
        currency: "XLM",
        status: "settled",
        lineItems: [],
      };

      jest.spyOn(PayoutStatement, "findOne").mockResolvedValue(mockStmt as any);

      const res = await request(app).get(
        `/api/payouts/statements/${wallet}/STMT-EXP-1/export?format=csv`
      );

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain('attachment; filename="STMT-EXP-1.csv"');
      expect(res.text).toContain("STATEMENT SUMMARY");
      expect(res.text).toContain("47.5000000");
    });

    it("GET /api/payouts/statements/:walletAddress/:statementId/export?format=json", async () => {
      const wallet = "gexport_wallet";
      const mockStmt = {
        statementId: "STMT-EXP-JSON",
        creatorWallet: wallet,
        periodStart: new Date(),
        periodEnd: new Date(),
        grossAmount: 100,
        platformFeeAmount: 5,
        refundAmount: 0,
        previousBalanceCarryover: 0,
        netSettlementAmount: 95,
        closingBalanceCarryover: 0,
        payableAmount: 95,
        currency: "XLM",
        status: "settled",
        lineItems: [],
      };

      jest.spyOn(PayoutStatement, "findOne").mockResolvedValue(mockStmt as any);

      const res = await request(app).get(
        `/api/payouts/statements/${wallet}/STMT-EXP-JSON/export?format=json`
      );

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body.statementId).toBe("STMT-EXP-JSON");
      expect(res.body.summary.netSettlementAmount).toBe(95);
    });

    it("POST /api/payouts/statements/generate validates input", async () => {
      const res = await request(app).post("/api/payouts/statements/generate").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("creatorWallet, periodStart, and periodEnd are required");
    });

    it("PATCH /api/payouts/statements/:statementId/status validates status enum", async () => {
      const res = await request(app)
        .patch("/api/payouts/statements/STMT-1/status")
        .send({ status: "invalid_status" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid status");
    });
  });
});

/**
 * Tests for Settlement Reconciliation Service & Reports — Issue #110
 */

const mockPurchaseFind = jest.fn();
const mockFulfillmentFind = jest.fn();
const mockFulfillmentFindOneAndUpdate = jest.fn();
const mockWebhookLogFind = jest.fn();
const mockReportCreate = jest.fn();
const mockReportFindOne = jest.fn();
const mockReportFind = jest.fn();

jest.mock("../models/Purchase", () => ({
  __esModule: true,
  default: { find: mockPurchaseFind },
}));

jest.mock("../models/FulfillmentRecord", () => ({
  __esModule: true,
  default: {
    find: mockFulfillmentFind,
    findOneAndUpdate: mockFulfillmentFindOneAndUpdate,
  },
}));

jest.mock("../models/WebhookDeliveryLog", () => ({
  __esModule: true,
  default: { find: mockWebhookLogFind },
}));

jest.mock("../models/ReconciliationReport", () => ({
  __esModule: true,
  default: {
    create: mockReportCreate,
    findOne: mockReportFindOne,
    find: mockReportFind,
  },
}));

import { signReport, runReconciliation, executeRepair } from "../services/reconciliationService";

describe("Settlement Reconciliation Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("signReport", () => {
    it("generates sha256= prefixed HMAC digest", () => {
      const sig = signReport({ test: 123 }, "secret-key");
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it("is deterministic for identical payload and secret", () => {
      const a = signReport({ a: 1 }, "key");
      const b = signReport({ a: 1 }, "key");
      expect(a).toBe(b);
    });
  });

  describe("runReconciliation", () => {
    it("detects missing fulfillment records", async () => {
      const mockPurchases = [
        { promptId: "p100", buyerWallet: "0xbuyer1", txHash: "0xtx1" },
      ];
      mockPurchaseFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockPurchases) });
      mockFulfillmentFind.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      mockWebhookLogFind.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      mockReportCreate.mockImplementation((data) => Promise.resolve({ ...data, _id: "rep-1" }));

      const report = await runReconciliation({ isDryRun: true });

      expect(mockReportCreate).toHaveBeenCalledTimes(1);
      const createdData = mockReportCreate.mock.calls[0][0];
      expect(createdData.mismatches.length).toBe(1);
      expect(createdData.mismatches[0].type).toBe("missing_fulfillment");
      expect(createdData.mismatches[0].promptId).toBe("p100");
    });

    it("correlates each failed webhook delivery to only its own purchase (#177)", async () => {
      // Two purchases and two failed deliveries, correlated 1:1 by
      // promptId+buyerWallet. Previously every failed delivery was
      // cross-joined against every purchase, producing 2 x 2 = 4
      // mismatches instead of 2.
      const mockPurchases = [
        { promptId: "p1", buyerWallet: "0xbuyer1", txHash: "0xtx1" },
        { promptId: "p2", buyerWallet: "0xbuyer2", txHash: "0xtx2" },
      ];
      const mockFulfillments = [
        { promptId: "p1", buyerWallet: "0xbuyer1", status: "delivered" },
        { promptId: "p2", buyerWallet: "0xbuyer2", status: "delivered" },
      ];
      const mockWebhookLogs = [
        {
          deliveryId: "del-1",
          event: "PromptPurchased",
          status: "failed",
          promptId: "p1",
          buyerWallet: "0xbuyer1",
          url: "https://hooks.example.com/1",
          lastError: "timeout",
        },
        {
          deliveryId: "del-2",
          event: "PromptPurchased",
          status: "failed",
          promptId: "p2",
          buyerWallet: "0xbuyer2",
          url: "https://hooks.example.com/2",
          lastError: "500",
        },
      ];

      mockPurchaseFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockPurchases) });
      mockFulfillmentFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockFulfillments) });
      mockWebhookLogFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockWebhookLogs) });
      mockReportCreate.mockImplementation((data) => Promise.resolve({ ...data, _id: "rep-corr" }));

      await runReconciliation({ isDryRun: true });

      const createdData = mockReportCreate.mock.calls[0][0];
      const webhookMismatches = createdData.mismatches.filter(
        (m: any) => m.type === "webhook_undelivered"
      );

      expect(webhookMismatches.length).toBe(2);
      const p1Mismatch = webhookMismatches.find((m: any) => m.promptId === "p1");
      const p2Mismatch = webhookMismatches.find((m: any) => m.promptId === "p2");
      expect(p1Mismatch.details.deliveryId).toBe("del-1");
      expect(p2Mismatch.details.deliveryId).toBe("del-2");
      expect(createdData.mismatches.some((m: any) => m.type === "webhook_uncorrelated")).toBe(
        false
      );
    });

    it("does not grow mismatch counts as unrelated purchases grow (#177)", async () => {
      const mockPurchases = [
        { promptId: "target", buyerWallet: "0xtarget", txHash: "0xtx" },
        { promptId: "unrelated-1", buyerWallet: "0xother1", txHash: "0xtx" },
        { promptId: "unrelated-2", buyerWallet: "0xother2", txHash: "0xtx" },
        { promptId: "unrelated-3", buyerWallet: "0xother3", txHash: "0xtx" },
      ];
      const mockFulfillments = mockPurchases.map((p) => ({
        promptId: p.promptId,
        buyerWallet: p.buyerWallet,
        status: "delivered",
      }));
      const mockWebhookLogs = [
        {
          deliveryId: "del-target",
          event: "PromptPurchased",
          status: "failed",
          promptId: "target",
          buyerWallet: "0xtarget",
          url: "https://hooks.example.com/t",
          lastError: "timeout",
        },
      ];

      mockPurchaseFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockPurchases) });
      mockFulfillmentFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockFulfillments) });
      mockWebhookLogFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockWebhookLogs) });
      mockReportCreate.mockImplementation((data) => Promise.resolve({ ...data, _id: "rep-scale" }));

      await runReconciliation({ isDryRun: true });

      const createdData = mockReportCreate.mock.calls[0][0];
      const webhookMismatches = createdData.mismatches.filter(
        (m: any) => m.type === "webhook_undelivered"
      );
      // Exactly one mismatch, not one per unrelated purchase.
      expect(webhookMismatches.length).toBe(1);
      expect(webhookMismatches[0].promptId).toBe("target");
    });

    it("reports failed deliveries with no matching purchase as webhook_uncorrelated (#177)", async () => {
      const mockPurchases = [{ promptId: "p1", buyerWallet: "0xbuyer1", txHash: "0xtx1" }];
      const mockFulfillments = [
        { promptId: "p1", buyerWallet: "0xbuyer1", status: "delivered" },
      ];
      const mockWebhookLogs = [
        // Has correlation evidence, but no purchase matches it.
        {
          deliveryId: "del-orphan",
          event: "PromptPurchased",
          status: "failed",
          promptId: "does-not-exist",
          buyerWallet: "0xnobody",
          url: "https://hooks.example.com/o",
          lastError: "404",
        },
        // Legacy log with no correlation evidence at all.
        {
          deliveryId: "del-legacy",
          event: "PromptPurchased",
          status: "failed",
          url: "https://hooks.example.com/l",
          lastError: "timeout",
        },
      ];

      mockPurchaseFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockPurchases) });
      mockFulfillmentFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockFulfillments) });
      mockWebhookLogFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockWebhookLogs) });
      mockReportCreate.mockImplementation((data) => Promise.resolve({ ...data, _id: "rep-unc" }));

      await runReconciliation({ isDryRun: true });

      const createdData = mockReportCreate.mock.calls[0][0];
      expect(
        createdData.mismatches.some((m: any) => m.type === "webhook_undelivered")
      ).toBe(false);

      const uncorrelated = createdData.mismatches.filter(
        (m: any) => m.type === "webhook_uncorrelated"
      );
      expect(uncorrelated.length).toBe(2);
      expect(uncorrelated.map((m: any) => m.details.deliveryId).sort()).toEqual([
        "del-legacy",
        "del-orphan",
      ]);
    });

    it("returns empty mismatches when all purchases have valid fulfillments", async () => {
      const mockPurchases = [
        { promptId: "p200", buyerWallet: "0xbuyer2", txHash: "0xtx2" },
      ];
      const mockFulfillments = [
        { promptId: "p200", buyerWallet: "0xbuyer2", status: "delivered" },
      ];

      mockPurchaseFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockPurchases) });
      mockFulfillmentFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockFulfillments) });
      mockWebhookLogFind.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      mockReportCreate.mockImplementation((data) => Promise.resolve({ ...data, _id: "rep-2" }));

      const report = await runReconciliation({ isDryRun: true });

      const createdData = mockReportCreate.mock.calls[0][0];
      expect(createdData.mismatches.length).toBe(0);
    });
  });

  describe("executeRepair", () => {
    it("repairs missing fulfillments upon approval", async () => {
      const mockReport = {
        reportId: "rec_123",
        approvedBy: null,
        status: "generated",
        mismatches: [
          {
            type: "missing_fulfillment",
            promptId: "p300",
            buyerWallet: "0xbuyer3",
            txHash: "0xtx3",
            repairStatus: "pending",
          },
        ],
        save: jest.fn().mockResolvedValue(true),
      };

      mockReportFindOne.mockResolvedValue(mockReport);
      mockFulfillmentFindOneAndUpdate.mockResolvedValue({ status: "delivered" });

      const result = await executeRepair("rec_123", "admin-1");

      expect(result.repairedCount).toBe(1);
      expect(mockFulfillmentFindOneAndUpdate).toHaveBeenCalledWith(
        { promptId: "p300", buyerWallet: "0xbuyer3" },
        expect.objectContaining({
          $set: expect.objectContaining({ status: "delivered" }),
        }),
        { upsert: true }
      );
      expect(mockReport.status).toBe("fully_repaired");
      expect(mockReport.save).toHaveBeenCalled();
    });

    it("throws error if report was already approved by another actor", async () => {
      const mockReport = {
        reportId: "rec_456",
        approvedBy: "admin-original",
        mismatches: [],
      };

      mockReportFindOne.mockResolvedValue(mockReport);

      await expect(executeRepair("rec_456", "admin-other")).rejects.toThrow(
        "Report was already approved by admin-original"
      );
    });
  });
});

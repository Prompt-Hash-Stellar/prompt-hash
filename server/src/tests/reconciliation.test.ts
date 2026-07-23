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

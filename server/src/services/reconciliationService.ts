import { createHmac, randomUUID } from "crypto";
import Purchase from "../models/Purchase";
import FulfillmentRecord from "../models/FulfillmentRecord";
import WebhookDeliveryLog from "../models/WebhookDeliveryLog";
import ReconciliationReport, { MismatchType } from "../models/ReconciliationReport";
import { dispatchEvent } from "./webhookDispatcher";

const RECONCILIATION_SECRET = process.env.RECONCILIATION_SECRET || "reconciliation-secret-key-123";

export function signReport(data: object, secret: string = RECONCILIATION_SECRET): string {
  const serialized = JSON.stringify(data);
  return `sha256=${createHmac("sha256", secret).update(serialized).digest("hex")}`;
}

export interface RunReconciliationOptions {
  isDryRun?: boolean;
  createdBy?: string;
}

export async function runReconciliation(options: RunReconciliationOptions = {}) {
  const isDryRun = options.isDryRun ?? true;
  const createdBy = options.createdBy ?? "system";
  const reportId = `rec_${randomUUID()}`;

  const purchases = await Purchase.find({}).lean();
  const fulfillments = await FulfillmentRecord.find({}).lean();
  const webhookLogs = await WebhookDeliveryLog.find({}).lean();

  const fulfillmentMap = new Map<string, any>();
  for (const f of fulfillments) {
    fulfillmentMap.set(`${f.promptId}:${f.buyerWallet.toLowerCase()}`, f);
  }

  const mismatches: Array<{
    type: MismatchType;
    promptId: string;
    buyerWallet: string;
    txHash?: string;
    details?: Record<string, unknown>;
    repairStatus: "pending" | "approved" | "completed" | "failed" | "skipped";
  }> = [];

  for (const p of purchases) {
    const key = `${p.promptId}:${p.buyerWallet.toLowerCase()}`;
    const f = fulfillmentMap.get(key);

    if (!f) {
      mismatches.push({
        type: "missing_fulfillment",
        promptId: p.promptId,
        buyerWallet: p.buyerWallet,
        txHash: p.txHash,
        details: { purchaseId: String(p._id) },
        repairStatus: "pending",
      });
    } else if (f.status === "failed") {
      mismatches.push({
        type: "missing_fulfillment",
        promptId: p.promptId,
        buyerWallet: p.buyerWallet,
        txHash: p.txHash,
        details: { fulfillmentStatus: "failed", failureReason: f.failureReason },
        repairStatus: "pending",
      });
    }

    const failedWebhooks = webhookLogs.filter(
      (w) => w.event === "PromptPurchased" && w.status === "failed"
    );
    for (const w of failedWebhooks) {
      mismatches.push({
        type: "webhook_undelivered",
        promptId: p.promptId,
        buyerWallet: p.buyerWallet,
        txHash: p.txHash,
        details: { deliveryId: w.deliveryId, url: w.url, lastError: w.lastError },
        repairStatus: "pending",
      });
    }
  }

  const summaryData = {
    reportId,
    totalDbPurchases: purchases.length,
    totalFulfillments: fulfillments.length,
    mismatchCount: mismatches.length,
    isDryRun,
  };

  const signature = signReport(summaryData);

  const report = await ReconciliationReport.create({
    reportId,
    totalDbPurchases: purchases.length,
    totalFulfillments: fulfillments.length,
    mismatches,
    isDryRun,
    signature,
    createdBy,
    status: "generated",
  });

  return report;
}

export async function executeRepair(reportId: string, approvedBy: string) {
  const report = await ReconciliationReport.findOne({ reportId });
  if (!report) {
    throw new Error(`Reconciliation report ${reportId} not found`);
  }

  if (report.approvedBy && report.approvedBy !== approvedBy) {
    throw new Error(`Report was already approved by ${report.approvedBy}`);
  }

  report.approvedBy = approvedBy;
  let repairedCount = 0;

  for (const item of report.mismatches) {
    if (item.repairStatus === "completed") continue;

    try {
      if (item.type === "missing_fulfillment") {
        await FulfillmentRecord.findOneAndUpdate(
          { promptId: item.promptId, buyerWallet: item.buyerWallet.toLowerCase() },
          {
            $set: {
              status: "delivered",
              txHash: item.txHash || "",
              deliveryAttemptedAt: new Date(),
            },
            $push: {
              auditLog: {
                status: "delivered",
                note: `Repaired via reconciliation report ${reportId} by ${approvedBy}`,
                at: new Date(),
              },
            },
          },
          { upsert: true }
        );
        item.repairStatus = "completed";
        item.repairedAt = new Date();
        repairedCount++;
      } else if (item.type === "webhook_undelivered") {
        await dispatchEvent(item.buyerWallet, "PromptPurchased", {
          promptId: item.promptId,
          buyerWallet: item.buyerWallet,
          reconciled: true,
        });
        item.repairStatus = "completed";
        item.repairedAt = new Date();
        repairedCount++;
      }
    } catch (err) {
      item.repairStatus = "failed";
      item.repairError = err instanceof Error ? err.message : String(err);
    }
  }

  const allDone = report.mismatches.every((m: any) => m.repairStatus === "completed");
  report.status = allDone ? "fully_repaired" : "partially_repaired";
  await report.save();

  return { report, repairedCount };
}

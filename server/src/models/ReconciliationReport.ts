import mongoose from "mongoose";

export type MismatchType =
  | "orphan_on_chain"
  | "missing_fulfillment"
  | "webhook_undelivered"
  | "webhook_uncorrelated"
  | "amount_mismatch";

export type RepairStatus = "pending" | "approved" | "completed" | "failed" | "skipped";

export interface IMismatchItem {
  type: MismatchType;
  promptId: string;
  buyerWallet: string;
  txHash?: string;
  details?: Record<string, unknown>;
  repairStatus: RepairStatus;
  repairedAt?: Date;
  repairError?: string;
}

const mismatchItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "orphan_on_chain",
        "missing_fulfillment",
        "webhook_undelivered",
        "webhook_uncorrelated",
        "amount_mismatch",
      ],
      required: true,
    },
    // promptId/buyerWallet are "unknown" (rather than required) for
    // webhook_uncorrelated mismatches, where a failed delivery could not be
    // matched to any purchase - see reconciliationService.ts.
    promptId: { type: String, required: true, default: "unknown" },
    buyerWallet: { type: String, required: true, lowercase: true, default: "unknown" },
    txHash: { type: String, default: "" },
    details: { type: mongoose.Schema.Types.Mixed },
    repairStatus: {
      type: String,
      enum: ["pending", "approved", "completed", "failed", "skipped"],
      default: "pending",
    },
    repairedAt: { type: Date },
    repairError: { type: String },
  },
  { _id: false }
);

const reconciliationReportSchema = new mongoose.Schema(
  {
    reportId: { type: String, required: true, unique: true, index: true },
    scannedLedgerStart: { type: Number, default: 0 },
    scannedLedgerEnd: { type: Number, default: 0 },
    totalOnChainPurchases: { type: Number, default: 0 },
    totalDbPurchases: { type: Number, default: 0 },
    totalFulfillments: { type: Number, default: 0 },
    mismatches: [mismatchItemSchema],
    isDryRun: { type: Boolean, default: true },
    signature: { type: String, required: true },
    createdBy: { type: String, default: "system" },
    approvedBy: { type: String, default: null },
    status: {
      type: String,
      enum: ["generated", "partially_repaired", "fully_repaired"],
      default: "generated",
    },
  },
  { timestamps: true }
);

reconciliationReportSchema.index({ createdAt: -1 });

const ReconciliationReport =
  mongoose.models.ReconciliationReport ||
  mongoose.model("ReconciliationReport", reconciliationReportSchema);

export default ReconciliationReport;

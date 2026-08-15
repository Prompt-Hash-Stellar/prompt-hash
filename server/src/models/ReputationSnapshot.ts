import mongoose from "mongoose";

export type SnapshotReason =
  | "review_added"
  | "review_edited"
  | "review_deleted"
  | "refund"
  | "fraud_confirmed"
  | "appeal_resolved"
  | "policy_upgrade"
  | "manual_rebuild";

const reputationSnapshotSchema = new mongoose.Schema(
  {
    sellerWallet: { type: String, required: true, lowercase: true, index: true },
    snapshotVersion: { type: Number, required: true },
    policyVersion: { type: Number, required: true },
    previousSnapshotId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReputationSnapshot",
      default: null,
    },
    reason: {
      type: String,
      enum: [
        "review_added",
        "review_edited",
        "review_deleted",
        "refund",
        "fraud_confirmed",
        "appeal_resolved",
        "policy_upgrade",
        "manual_rebuild",
      ],
      required: true,
    },
    sampleSize: { type: Number, required: true },
    excludedCount: { type: Number, default: 0 },
    rawAverage: { type: Number, required: true },
    weightedScore: { type: Number, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    decayHalfLifeDays: { type: Number, required: true },
    // sha256 of the eligible-review inputs + policy version — lets anyone
    // reproduce this exact score from the same inputs (#109).
    inputsHash: { type: String, required: true },
    explanationCodes: { type: [String], default: [] },
    asOf: { type: Date, required: true },
  },
  { timestamps: true },
);

reputationSnapshotSchema.index({ sellerWallet: 1, snapshotVersion: -1 });

const ReputationSnapshot =
  mongoose.models.ReputationSnapshot ||
  mongoose.model("ReputationSnapshot", reputationSnapshotSchema);

export default ReputationSnapshot;

import mongoose from "mongoose";

export type AppealStatus =
  | "flagged"
  | "notified"
  | "responded"
  | "reviewed"
  | "upheld"
  | "rejected"
  | "appealed";

export type ReviewerDecision = {
  reviewerAddress: string;
  decision: "upheld" | "rejected";
  reasonCode: string;
  evidenceHash: string;
  decisionVersion: number;
  decidedAt: Date;
  conflictOfInterest: boolean;
};

const appealSchema = new mongoose.Schema(
  {
    promptId: {
      type: String,
      required: true,
      index: true,
    },
    reporterAddress: {
      type: String,
      required: true,
      lowercase: true,
    },
    creatorAddress: {
      type: String,
      required: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: [
        "flagged",
        "notified",
        "responded",
        "reviewed",
        "upheld",
        "rejected",
        "appealed",
      ],
      default: "flagged",
      index: true,
    },
    similarityScore: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
    },
    algorithmVersion: {
      type: Number,
      required: true,
      default: 1,
    },
    contentCommitment: {
      type: String,
      required: true,
    },
    fingerprintHash: {
      type: String,
      required: true,
    },
    evidenceHash: {
      type: String,
      default: null,
    },
    creatorResponse: {
      type: String,
      default: null,
      maxlength: 2000,
    },
    reasonCode: {
      type: String,
      default: null,
    },
    decisionVersion: {
      type: Number,
      default: 1,
    },
    reviewerDecisions: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    previousDecisions: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    notifiedAt: {
      type: Date,
      default: null,
    },
    respondedAt: {
      type: Date,
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    appealedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

appealSchema.index({ status: 1, createdAt: -1 });
appealSchema.index({ promptId: 1, status: 1 });

const Appeal =
  mongoose.models.Appeal || mongoose.model("Appeal", appealSchema);

export default Appeal;

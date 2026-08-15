import mongoose from "mongoose";

export type AbuseFlagCode =
  | "SELF_REVIEW"
  | "RECIPROCAL_RING"
  | "BURST_PATTERN"
  | "LINKED_WALLET_CLUSTER"
  | "REFUND_INVALIDATED"
  | "FRAUD_CONFIRMED";

export type ReviewFlagStatus = "active" | "appealed" | "overturned" | "upheld";

const reviewFlagSchema = new mongoose.Schema(
  {
    reviewId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Review",
      required: true,
      index: true,
    },
    promptId: { type: String, required: true, index: true },
    sellerWallet: { type: String, required: true, lowercase: true, index: true },
    reviewerWallet: { type: String, required: true, lowercase: true },
    code: {
      type: String,
      enum: [
        "SELF_REVIEW",
        "RECIPROCAL_RING",
        "BURST_PATTERN",
        "LINKED_WALLET_CLUSTER",
        "REFUND_INVALIDATED",
        "FRAUD_CONFIRMED",
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "appealed", "overturned", "upheld"],
      default: "active",
      index: true,
    },
    // Internal-only signal detail (never exposed via API — clients only ever
    // see `code`). Kept for moderation/appeal review.
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

const ReviewFlag = mongoose.models.ReviewFlag || mongoose.model("ReviewFlag", reviewFlagSchema);
export default ReviewFlag;

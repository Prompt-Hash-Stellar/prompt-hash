import mongoose from "mongoose";

export type ReviewAppealStatus = "pending" | "approved" | "denied";

const reviewAppealSchema = new mongoose.Schema(
  {
    flagId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReviewFlag",
      required: true,
      index: true,
    },
    reviewId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Review",
      required: true,
    },
    appellantWallet: { type: String, required: true, lowercase: true },
    reason: { type: String, required: true, maxlength: 1000 },
    status: {
      type: String,
      enum: ["pending", "approved", "denied"],
      default: "pending",
      index: true,
    },
    resolvedBy: { type: String, default: "" },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: "" },
  },
  { timestamps: true },
);

const ReviewAppeal =
  mongoose.models.ReviewAppeal || mongoose.model("ReviewAppeal", reviewAppealSchema);
export default ReviewAppeal;

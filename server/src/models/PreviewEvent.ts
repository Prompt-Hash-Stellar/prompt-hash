import mongoose from "mongoose";

const previewEventSchema = new mongoose.Schema(
  {
    promptId: { type: mongoose.Schema.Types.ObjectId, ref: "Prompt", index: true },
    visitorHash: { type: String, required: true, index: true },
    outcome: {
      type: String,
      required: true,
      enum: ["counted", "deduped", "rate_limited", "bot_filtered", "invalid_token", "invalid_prompt"],
      index: true,
    },
    reason: { type: String, required: true },
    windowStart: { type: Date, required: true, index: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

previewEventSchema.index({ promptId: 1, outcome: 1, createdAt: -1 });

export const PreviewEvent =
  mongoose.models.PreviewEvent || mongoose.model("PreviewEvent", previewEventSchema);

const previewClaimSchema = new mongoose.Schema(
  {
    promptId: { type: mongoose.Schema.Types.ObjectId, ref: "Prompt", required: true },
    visitorHash: { type: String, required: true },
    windowStart: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

previewClaimSchema.index(
  { promptId: 1, visitorHash: 1, windowStart: 1 },
  { unique: true },
);

export const PreviewClaim =
  mongoose.models.PreviewClaim || mongoose.model("PreviewClaim", previewClaimSchema);

const previewRateBucketSchema = new mongoose.Schema({
  visitorHash: { type: String, required: true },
  windowStart: { type: Date, required: true },
  count: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

previewRateBucketSchema.index(
  { visitorHash: 1, windowStart: 1 },
  { unique: true },
);

export const PreviewRateBucket =
  mongoose.models.PreviewRateBucket ||
  mongoose.model("PreviewRateBucket", previewRateBucketSchema);

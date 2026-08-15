import mongoose from "mongoose";

const reviewHistoryEntrySchema = new mongoose.Schema(
  {
    rating: { type: Number, required: true },
    text: { type: String, default: "" },
    editedAt: { type: Date, required: true },
  },
  { _id: false },
);

const reviewSchema = new mongoose.Schema(
  {
    promptId: {
      type: String,
      required: true,
      index: true,
    },
    userAddress: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    // The specific purchase this review is eligible against (#109).
    // One purchase can back at most one review.
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      required: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    text: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
    verified: {
      type: Boolean,
      default: false,
    },
    // Soft lifecycle status: edits/deletes never rewrite past reputation
    // snapshots, they only affect snapshots computed afterwards (#109).
    status: {
      type: String,
      enum: ["active", "edited", "deleted"],
      default: "active",
      index: true,
    },
    version: {
      type: Number,
      default: 1,
    },
    history: {
      type: [reviewHistoryEntrySchema],
      default: [],
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// One review per purchase (#109 — replaces the old one-per-user-per-prompt rule
// so repeat buyers of a re-purchasable prompt can leave one review per purchase).
reviewSchema.index({ purchaseId: 1 }, { unique: true });
reviewSchema.index({ promptId: 1, userAddress: 1 });

const Review = mongoose.models.Review || mongoose.model("Review", reviewSchema);
export default Review;

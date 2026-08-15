import mongoose from "mongoose";

const purchaseSchema = new mongoose.Schema(
  {
    promptId: {
      type: String,
      required: true,
      index: true,
    },
    buyerWallet: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    versionIndex: {
      type: Number,
      required: true,
    },
    txHash: {
      type: String,
      default: "",
    },
    saved: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Anti-abuse / reputation eligibility fields (#109).
    // Refund status is tracked by FulfillmentRecord.status === "refunded" —
    // reputation eligibility reads that as the source of truth.
    fraudConfirmed: {
      type: Boolean,
      default: false,
      index: true,
    },
    fraudConfirmedAt: {
      type: Date,
      default: null,
    },
    // Optional privacy-conscious clustering key (e.g. hash of the funding
    // source account). Never a raw address — only ever compared for equality.
    fundingSourceHash: {
      type: String,
      default: "",
      index: true,
    },
  },
  { timestamps: true },
);

purchaseSchema.index({ promptId: 1, buyerWallet: 1 });

const Purchase = mongoose.models.Purchase || mongoose.model("Purchase", purchaseSchema);
export default Purchase;

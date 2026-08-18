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
  },
  { timestamps: true },
);

// Enforce exactly one purchase/entitlement record per prompt+buyer pair at
// the database level so concurrent confirmations cannot create duplicate
// entitlements or leave version selection ambiguous.
purchaseSchema.index({ promptId: 1, buyerWallet: 1 }, { unique: true });

const Purchase = mongoose.models.Purchase || mongoose.model("Purchase", purchaseSchema);
export default Purchase;

import mongoose from "mongoose";

const indexerStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    lastIndexedLedger: { type: Number, default: 0 },
    sourceCheckpoint: { type: Number, default: 0 },
    rawEventCheckpoint: { type: Number, default: 0 },
    projectionCheckpoint: { type: Number, default: 0 },
    quarantinedFailures: { type: Number, default: 0 },
    leaseOwner: { type: String, default: null },
    leaseFencingToken: { type: Number, default: 0 },
    leaseExpiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const IndexerState = mongoose.model("IndexerState", indexerStateSchema);

import mongoose from "mongoose";

/**
 * Persisted record for malformed or unsupported contract events quarantined during indexing.
 */
const deadLetterEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true, index: true },
    detectedVersion: { type: mongoose.Schema.Types.Mixed, default: null },
    reason: { type: String, required: true, index: true },
    details: { type: String, required: true },
    rawPayload: { type: mongoose.Schema.Types.Mixed, required: true },
    ledger: { type: Number, default: null, index: true },
    transaction: { type: String, default: null, index: true },
    eventIndex: { type: Number, default: null },
    timestamp: { type: Number, required: true },
    recoverable: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const DeadLetterEvent = mongoose.model(
  "DeadLetterEvent",
  deadLetterEventSchema,
);

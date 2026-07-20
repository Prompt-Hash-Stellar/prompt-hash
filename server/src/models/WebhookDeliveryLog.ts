import mongoose from "mongoose";

const webhookDeliveryLogSchema = new mongoose.Schema(
  {
    deliveryId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WebhookSubscription",
      required: true,
      index: true,
    },
    event: {
      type: String,
      required: true,
      index: true,
    },
    url: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "success", "failed", "retrying"],
      default: "pending",
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastStatus: {
      type: Number,
      default: null,
    },
    lastError: {
      type: String,
      default: null,
    },
    nextRetryAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

webhookDeliveryLogSchema.index({ event: 1, createdAt: -1 });
webhookDeliveryLogSchema.index({ subscriptionId: 1, createdAt: -1 });

const WebhookDeliveryLog =
  mongoose.models.WebhookDeliveryLog ||
  mongoose.model("WebhookDeliveryLog", webhookDeliveryLogSchema);

export default WebhookDeliveryLog;

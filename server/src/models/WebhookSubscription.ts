import mongoose from "mongoose";

const previousSecretSchema = new mongoose.Schema(
  {
    secret: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { _id: false },
);

const webhookSubscriptionSchema = new mongoose.Schema(
  {
    walletAddress: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    secret: {
      type: String,
      required: true,
    },
    // Monotonically increasing counter used for optimistic concurrency when
    // rotating the secret. Ensures concurrent updates cannot return a secret
    // that no longer matches the persisted value.
    secretVersion: {
      type: Number,
      default: 1,
    },
    // Previous secrets retained for a bounded overlap window after rotation so
    // deliveries already signed with the old secret still verify until expiry.
    previousSecrets: {
      type: [previousSecretSchema],
      default: [],
    },
    events: {
      type: [String],
      default: ["PromptPurchased"],
    },
    active: {
      type: Boolean,
      default: true,
    },
    failureCount: {
      type: Number,
      default: 0,
    },
    lastDeliveredAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

const WebhookSubscription =
  mongoose.models.WebhookSubscription ||
  mongoose.model("WebhookSubscription", webhookSubscriptionSchema);

export default WebhookSubscription;

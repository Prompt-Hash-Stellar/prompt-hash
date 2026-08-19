import mongoose, { Document, Schema } from "mongoose";

export type JobStatus = "pending" | "processing" | "completed" | "failed" | "dead-letter" | "skipped";
export type NotificationEvent = "PromptPurchased" | "PromptUpdated";

export interface IEmailNotificationJob extends Document {
  idempotencyKey: string;
  event: NotificationEvent;
  recipientWallet: string;
  recipientEmail: string | null;
  preferenceSnapshot: {
    optedIn: boolean;
  };
  payload: Record<string, any>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextRetryAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const emailNotificationJobSchema = new Schema<IEmailNotificationJob>(
  {
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    event: {
      type: String,
      required: true,
      enum: ["PromptPurchased", "PromptUpdated"],
      index: true,
    },
    recipientWallet: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    recipientEmail: {
      type: String,
      default: null,
    },
    preferenceSnapshot: {
      optedIn: {
        type: Boolean,
        required: true,
        default: true,
      },
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "dead-letter", "skipped"],
      default: "pending",
      index: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      default: 3,
    },
    lastError: {
      type: String,
      default: null,
    },
    nextRetryAt: {
      type: Date,
      default: null,
      index: true,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

emailNotificationJobSchema.index({ status: 1, nextRetryAt: 1 });
emailNotificationJobSchema.index({ event: 1, createdAt: -1 });

const EmailNotificationJob =
  mongoose.models.EmailNotificationJob ||
  mongoose.model<IEmailNotificationJob>("EmailNotificationJob", emailNotificationJobSchema);

export default EmailNotificationJob;

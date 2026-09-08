import mongoose, { Document, Schema } from "mongoose";

export type PayoutStatus = "pending" | "settled" | "failed";
export type LineItemType = "sale" | "platform_fee" | "refund" | "clawback" | "carryover";
export type LineItemStatus = "pending" | "settled" | "failed" | "refunded" | "clawback";

export interface IPayoutLineItem {
  lineItemId: string;
  date: Date;
  type: LineItemType;
  promptId?: string;
  promptTitle?: string;
  buyerWallet?: string;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  status: LineItemStatus;
  txHash?: string;
  notes?: string;
}

export interface IPayoutStatement extends Document {
  statementId: string;
  creatorWallet: string;
  periodStart: Date;
  periodEnd: Date;
  grossAmount: number;
  platformFeeAmount: number;
  refundAmount: number;
  previousBalanceCarryover: number;
  netSettlementAmount: number;
  closingBalanceCarryover: number;
  payableAmount: number;
  currency: string;
  status: PayoutStatus;
  payoutTxHash?: string | null;
  failureReason?: string | null;
  settledAt?: Date | null;
  lineItems: IPayoutLineItem[];
  createdAt: Date;
  updatedAt: Date;
}

const PayoutLineItemSchema = new Schema<IPayoutLineItem>(
  {
    lineItemId: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    type: {
      type: String,
      enum: ["sale", "platform_fee", "refund", "clawback", "carryover"],
      required: true,
    },
    promptId: {
      type: String,
      default: null,
    },
    promptTitle: {
      type: String,
      default: null,
    },
    buyerWallet: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
    grossAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    feeAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    netAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    status: {
      type: String,
      enum: ["pending", "settled", "failed", "refunded", "clawback"],
      required: true,
      default: "pending",
    },
    txHash: {
      type: String,
      default: null,
    },
    notes: {
      type: String,
      default: null,
    },
  },
  { _id: false }
);

const PayoutStatementSchema = new Schema<IPayoutStatement>(
  {
    statementId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    creatorWallet: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    periodStart: {
      type: Date,
      required: true,
      index: true,
    },
    periodEnd: {
      type: Date,
      required: true,
      index: true,
    },
    grossAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    platformFeeAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    refundAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    previousBalanceCarryover: {
      type: Number,
      required: true,
      default: 0,
    },
    netSettlementAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    closingBalanceCarryover: {
      type: Number,
      required: true,
      default: 0,
    },
    payableAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      default: "XLM",
    },
    status: {
      type: String,
      enum: ["pending", "settled", "failed"],
      default: "pending",
      index: true,
    },
    payoutTxHash: {
      type: String,
      default: null,
      index: true,
    },
    failureReason: {
      type: String,
      default: null,
    },
    settledAt: {
      type: Date,
      default: null,
    },
    lineItems: {
      type: [PayoutLineItemSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

PayoutStatementSchema.index({ creatorWallet: 1, periodStart: -1 });
PayoutStatementSchema.index({ creatorWallet: 1, status: 1 });

const PayoutStatement =
  mongoose.models.PayoutStatement ||
  mongoose.model<IPayoutStatement>("PayoutStatement", PayoutStatementSchema);

export default PayoutStatement;

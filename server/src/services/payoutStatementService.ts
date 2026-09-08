import { randomUUID } from "crypto";
import PayoutStatement, {
  IPayoutLineItem,
  IPayoutStatement,
  PayoutStatus,
} from "../models/PayoutStatement";
import Purchase from "../models/Purchase";
import Prompt from "../models/Prompt";
import User from "../models/User";
import FulfillmentRecord from "../models/FulfillmentRecord";

export const DEFAULT_PLATFORM_FEE_BPS = 500; // 5.00%

/**
 * Calculates platform fee given a gross amount and fee basis points.
 * Uses 7 decimal places (Stellar stroop precision).
 */
export function calculatePlatformFee(
  amount: number,
  feeBps: number = DEFAULT_PLATFORM_FEE_BPS
): number {
  if (amount <= 0 || feeBps <= 0) return 0;
  const rawFee = (amount * feeBps) / 10_000;
  return Number(rawFee.toFixed(7));
}

export interface GenerateStatementParams {
  creatorWallet: string;
  periodStart: Date | string;
  periodEnd: Date | string;
  platformFeeBps?: number;
  persist?: boolean;
}

export interface StatementExportOptions {
  includeLineItems?: boolean;
}

/**
 * Generates and optionally persists a PayoutStatement for a creator across an arbitrary date range.
 * Strictly reconciles gross sales, 5% platform fees, refunds, and clawback carryovers.
 */
export async function generatePayoutStatement(
  params: GenerateStatementParams
): Promise<IPayoutStatement> {
  const {
    creatorWallet,
    platformFeeBps = DEFAULT_PLATFORM_FEE_BPS,
    persist = false,
  } = params;

  const normalizedWallet = creatorWallet.trim().toLowerCase();
  const startDate = new Date(params.periodStart);
  const endDate = new Date(params.periodEnd);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw new Error("Invalid period dates provided.");
  }
  if (startDate > endDate) {
    throw new Error("periodStart must be before or equal to periodEnd.");
  }

  // 1. Locate creator's user account and associated prompt IDs
  const user = await User.findOne({ walletAddress: normalizedWallet }).lean();
  const promptFilter: any = {
    $or: [{ owner: user?._id }],
  };
  const prompts = await Prompt.find(promptFilter).lean();
  const promptMap = new Map<string, any>();
  const promptIds: string[] = [];

  for (const p of prompts) {
    const id = p.onChainId || String(p._id);
    promptMap.set(id, p);
    promptMap.set(String(p._id), p);
    promptIds.push(id);
    promptIds.push(String(p._id));
  }

  // 2. Fetch purchases occurring strictly within [startDate, endDate]
  const purchases = await Purchase.find({
    promptId: { $in: promptIds },
    createdAt: { $gte: startDate, $lte: endDate },
  }).lean();

  // 3. Fetch refund records occurring within [startDate, endDate]
  const refunds = await FulfillmentRecord.find({
    promptId: { $in: promptIds },
    status: "refunded",
    updatedAt: { $gte: startDate, $lte: endDate },
  }).lean();

  // 4. Check for unrecovered negative balance from previous period statements
  const latestPriorStatement = await PayoutStatement.findOne({
    creatorWallet: normalizedWallet,
    periodEnd: { $lte: startDate },
  })
    .sort({ periodEnd: -1 })
    .lean();

  const previousBalanceCarryover =
    latestPriorStatement && latestPriorStatement.closingBalanceCarryover < 0
      ? latestPriorStatement.closingBalanceCarryover
      : 0;

  const lineItems: IPayoutLineItem[] = [];
  let grossAmount = 0;
  let platformFeeAmount = 0;
  let refundAmount = 0;

  // Add prior carryover line item if deficit exists
  if (previousBalanceCarryover < 0) {
    lineItems.push({
      lineItemId: `li_carryover_${randomUUID().substring(0, 8)}`,
      date: startDate,
      type: "carryover",
      grossAmount: 0,
      feeAmount: 0,
      netAmount: previousBalanceCarryover,
      status: "clawback",
      notes: `Unrecovered deficit carried over from statement ${latestPriorStatement?.statementId || "previous"}`,
    });
  }

  // Process sales line items
  for (const purchase of purchases) {
    const prompt = promptMap.get(purchase.promptId);
    const price = Number(prompt?.price ?? 0);
    const fee = calculatePlatformFee(price, platformFeeBps);
    const net = Number((price - fee).toFixed(7));

    grossAmount += price;
    platformFeeAmount += fee;

    lineItems.push({
      lineItemId: `li_sale_${randomUUID().substring(0, 8)}`,
      date: new Date(purchase.createdAt),
      type: "sale",
      promptId: purchase.promptId,
      promptTitle: prompt?.title || "Untitled Prompt",
      buyerWallet: purchase.buyerWallet,
      grossAmount: price,
      feeAmount: fee,
      netAmount: net,
      status: "settled",
      txHash: purchase.txHash || undefined,
      notes: `Purchase of prompt #${purchase.promptId}`,
    });
  }

  // Process refunds & clawbacks
  for (const ref of refunds) {
    const prompt = promptMap.get(ref.promptId);
    const price = Number(prompt?.price ?? 0);
    const fee = calculatePlatformFee(price, platformFeeBps);
    const creatorShare = Number((price - fee).toFixed(7));

    // Determine if refund was for a purchase in a prior period
    const purchaseDate = new Date(ref.createdAt);
    const isPriorPeriod = purchaseDate < startDate;
    const type = isPriorPeriod ? "clawback" : "refund";

    refundAmount += creatorShare;

    lineItems.push({
      lineItemId: `li_refund_${randomUUID().substring(0, 8)}`,
      date: new Date(ref.updatedAt),
      type,
      promptId: ref.promptId,
      promptTitle: prompt?.title || "Untitled Prompt",
      buyerWallet: ref.buyerWallet,
      grossAmount: 0,
      feeAmount: 0,
      netAmount: -creatorShare,
      status: "refunded",
      notes: isPriorPeriod
        ? `Clawback: refund for purchase made in prior period (${purchaseDate.toISOString()})`
        : `Refund: dispute resolved for purchase (${ref.refundReason || "buyer refund"})`,
    });
  }

  grossAmount = Number(grossAmount.toFixed(7));
  platformFeeAmount = Number(platformFeeAmount.toFixed(7));
  refundAmount = Number(refundAmount.toFixed(7));

  // Reconciliation Formula:
  // netSettlementAmount = grossAmount - platformFeeAmount - refundAmount + previousBalanceCarryover
  const netSettlementAmount = Number(
    (
      grossAmount -
      platformFeeAmount -
      refundAmount +
      previousBalanceCarryover
    ).toFixed(7)
  );

  const closingBalanceCarryover = netSettlementAmount < 0 ? netSettlementAmount : 0;
  const payableAmount = netSettlementAmount > 0 ? netSettlementAmount : 0;

  const statementId = `STMT-${normalizedWallet.substring(0, 6).toUpperCase()}-${Date.now()}`;

  const statementDoc = new PayoutStatement({
    statementId,
    creatorWallet: normalizedWallet,
    periodStart: startDate,
    periodEnd: endDate,
    grossAmount,
    platformFeeAmount,
    refundAmount,
    previousBalanceCarryover,
    netSettlementAmount,
    closingBalanceCarryover,
    payableAmount,
    currency: "XLM",
    status: "pending",
    payoutTxHash: null,
    failureReason: null,
    settledAt: null,
    lineItems,
  });

  if (persist) {
    await statementDoc.save();
  }

  return statementDoc;
}

/**
 * Updates a statement's settlement status, recording on-chain payout transaction or failure reason.
 */
export async function updateStatementStatus(
  statementId: string,
  update: {
    status: PayoutStatus;
    payoutTxHash?: string;
    failureReason?: string;
    settledAt?: Date;
  }
): Promise<IPayoutStatement | null> {
  const fieldsToUpdate: any = {
    status: update.status,
  };

  if (update.status === "settled") {
    fieldsToUpdate.payoutTxHash = update.payoutTxHash || null;
    fieldsToUpdate.settledAt = update.settledAt || new Date();
    fieldsToUpdate.failureReason = null;
  } else if (update.status === "failed") {
    fieldsToUpdate.failureReason = update.failureReason || "Payout execution failed";
    fieldsToUpdate.payoutTxHash = null;
    fieldsToUpdate.settledAt = null;
  } else {
    fieldsToUpdate.failureReason = null;
    fieldsToUpdate.payoutTxHash = null;
    fieldsToUpdate.settledAt = null;
  }

  return PayoutStatement.findOneAndUpdate(
    { statementId },
    { $set: fieldsToUpdate },
    { new: true }
  );
}

/**
 * Escapes values for RFC-4180 CSV compliance.
 */
function escapeCsvValue(val: any): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Exports a payout statement to RFC-4180 compliant CSV string.
 */
export function exportStatementAsCsv(statement: IPayoutStatement): string {
  const rows: string[] = [];

  // 1. Metadata & Summary Header
  rows.push(["STATEMENT SUMMARY"].map(escapeCsvValue).join(","));
  rows.push(["Statement ID", statement.statementId].map(escapeCsvValue).join(","));
  rows.push(["Creator Wallet", statement.creatorWallet].map(escapeCsvValue).join(","));
  rows.push(["Period Start", new Date(statement.periodStart).toISOString()].map(escapeCsvValue).join(","));
  rows.push(["Period End", new Date(statement.periodEnd).toISOString()].map(escapeCsvValue).join(","));
  rows.push(["Currency", statement.currency].map(escapeCsvValue).join(","));
  rows.push(["Gross Sales", statement.grossAmount.toFixed(7)].map(escapeCsvValue).join(","));
  rows.push(["Platform Fee Amount", statement.platformFeeAmount.toFixed(7)].map(escapeCsvValue).join(","));
  rows.push(["Refund Amount", statement.refundAmount.toFixed(7)].map(escapeCsvValue).join(","));
  rows.push(["Previous Balance Carryover", statement.previousBalanceCarryover.toFixed(7)].map(escapeCsvValue).join(","));
  rows.push(["Net Settlement Amount", statement.netSettlementAmount.toFixed(7)].map(escapeCsvValue).join(","));
  rows.push(["Closing Balance Carryover", statement.closingBalanceCarryover.toFixed(7)].map(escapeCsvValue).join(","));
  rows.push(["Payable Amount", statement.payableAmount.toFixed(7)].map(escapeCsvValue).join(","));
  rows.push(["Settlement Status", statement.status].map(escapeCsvValue).join(","));
  rows.push(["Payout Transaction Hash", statement.payoutTxHash || ""].map(escapeCsvValue).join(","));
  rows.push(["Failure Reason", statement.failureReason || ""].map(escapeCsvValue).join(","));
  rows.push(["Settled At", statement.settledAt ? new Date(statement.settledAt).toISOString() : ""].map(escapeCsvValue).join(","));
  rows.push(""); // blank line separation

  // 2. Line Items Table
  rows.push(["TRANSACTION LINE ITEMS"].map(escapeCsvValue).join(","));
  const headers = [
    "Line Item ID",
    "Date",
    "Type",
    "Prompt ID",
    "Prompt Title",
    "Buyer Wallet",
    "Gross Amount",
    "Fee Amount",
    "Net Amount",
    "Status",
    "Tx Hash",
    "Notes",
  ];
  rows.push(headers.map(escapeCsvValue).join(","));

  for (const item of statement.lineItems || []) {
    const row = [
      item.lineItemId,
      new Date(item.date).toISOString(),
      item.type,
      item.promptId || "",
      item.promptTitle || "",
      item.buyerWallet || "",
      item.grossAmount.toFixed(7),
      item.feeAmount.toFixed(7),
      item.netAmount.toFixed(7),
      item.status,
      item.txHash || "",
      item.notes || "",
    ];
    rows.push(row.map(escapeCsvValue).join(","));
  }

  return rows.join("\r\n");
}

/**
 * Exports a payout statement to structured JSON.
 */
export function exportStatementAsJson(statement: IPayoutStatement): Record<string, any> {
  return {
    statementId: statement.statementId,
    creatorWallet: statement.creatorWallet,
    periodStart: new Date(statement.periodStart).toISOString(),
    periodEnd: new Date(statement.periodEnd).toISOString(),
    currency: statement.currency,
    summary: {
      grossAmount: statement.grossAmount,
      platformFeeAmount: statement.platformFeeAmount,
      refundAmount: statement.refundAmount,
      previousBalanceCarryover: statement.previousBalanceCarryover,
      netSettlementAmount: statement.netSettlementAmount,
      closingBalanceCarryover: statement.closingBalanceCarryover,
      payableAmount: statement.payableAmount,
      status: statement.status,
      payoutTxHash: statement.payoutTxHash || null,
      failureReason: statement.failureReason || null,
      settledAt: statement.settledAt ? new Date(statement.settledAt).toISOString() : null,
    },
    lineItems: (statement.lineItems || []).map((item) => ({
      lineItemId: item.lineItemId,
      date: new Date(item.date).toISOString(),
      type: item.type,
      promptId: item.promptId || null,
      promptTitle: item.promptTitle || null,
      buyerWallet: item.buyerWallet || null,
      grossAmount: item.grossAmount,
      feeAmount: item.feeAmount,
      netAmount: item.netAmount,
      status: item.status,
      txHash: item.txHash || null,
      notes: item.notes || null,
    })),
  };
}

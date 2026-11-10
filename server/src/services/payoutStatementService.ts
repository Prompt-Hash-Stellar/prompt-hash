import { createHmac, randomUUID } from "crypto";
import {
  PayoutStatement,
  PayoutPeriod,
  SaleLineItem,
  RefundLineItem,
  FailedPayoutLineItem,
} from "../types/PayoutStatement";

const PAYOUT_SECRET = process.env.PAYOUT_SECRET || "payout-statement-secret-key";

export function signPayoutStatement(data: object, secret: string = PAYOUT_SECRET): string {
  const serialized = JSON.stringify(data);
  return `sha256=${createHmac("sha256", secret).update(serialized).digest("hex")}`;
}

export interface RawEventInput {
  sales?: SaleLineItem[];
  refunds?: RefundLineItem[];
  failedPayouts?: FailedPayoutLineItem[];
}

/**
 * Generate a reconciled payout statement for a given seller and billing period.
 */
export function generatePayoutStatement(
  sellerId: string,
  period: PayoutPeriod,
  events: RawEventInput,
  secret: string = PAYOUT_SECRET
): PayoutStatement {
  const sales = events.sales ?? [];
  const refundItems = events.refunds ?? [];
  const failedPayoutItems = events.failedPayouts ?? [];

  const totalSales = sales.reduce((acc, item) => acc + item.grossAmount, 0);
  const platformFee = sales.reduce((acc, item) => acc + item.platformFee, 0);
  const refunds = refundItems.reduce((acc, item) => acc + item.refundAmount, 0);
  const failedPayouts = failedPayoutItems.reduce((acc, item) => acc + item.amount, 0);

  // Exact net settlement formula
  const netSettlement = totalSales - platformFee - refunds - failedPayouts;

  const statementData: Omit<PayoutStatement, "signature"> = {
    statementId: `stmt_${sellerId}_${randomUUID().slice(0, 8)}`,
    sellerId,
    period,
    saleCount: sales.length,
    totalSales,
    platformFee,
    refunds,
    failedPayouts,
    netSettlement,
    sales,
    refundItems,
    failedPayoutItems,
    generatedAt: new Date().toISOString(),
  };

  const signature = signPayoutStatement(statementData, secret);

  return {
    ...statementData,
    signature,
  };
}

/**
 * Export payout statement to CSV format.
 */
export function exportStatementToCsv(statement: PayoutStatement): string {
  const lines: string[] = [];

  // Metadata headers
  lines.push("=== PAYOUT STATEMENT SUMMARY ===");
  lines.push(`Statement ID,${statement.statementId}`);
  lines.push(`Seller ID,${statement.sellerId}`);
  lines.push(`Period Start,${statement.period.start}`);
  lines.push(`Period End,${statement.period.end}`);
  lines.push(`Generated At,${statement.generatedAt}`);
  lines.push(`Sale Count,${statement.saleCount}`);
  lines.push(`Total Sales,${statement.totalSales}`);
  lines.push(`Platform Fee,${statement.platformFee}`);
  lines.push(`Refunds,${statement.refunds}`);
  lines.push(`Failed Payouts,${statement.failedPayouts}`);
  lines.push(`Net Settlement,${statement.netSettlement}`);
  lines.push("");

  // Sales detail
  lines.push("=== SALES DETAIL ===");
  lines.push("Purchase ID,Prompt ID,Gross Amount,Platform Fee,Net Amount,Purchased At");
  for (const s of statement.sales) {
    lines.push(
      `${s.purchaseId},${s.promptId},${s.grossAmount},${s.platformFee},${s.netAmount},${s.purchasedAt}`
    );
  }
  lines.push("");

  // Refunds detail
  lines.push("=== REFUNDS DETAIL ===");
  lines.push("Purchase ID,Prompt ID,Refund Amount,Fee Reinstatement,Refunded At");
  for (const r of statement.refundItems) {
    lines.push(
      `${r.purchaseId},${r.promptId},${r.refundAmount},${r.feeReinstatement},${r.refundedAt}`
    );
  }
  lines.push("");

  // Failed payouts detail
  lines.push("=== FAILED PAYOUTS DETAIL ===");
  lines.push("Purchase ID,Prompt ID,Amount,Reason,Failed At");
  for (const f of statement.failedPayoutItems) {
    lines.push(`${f.purchaseId},${f.promptId},${f.amount},"${f.reason.replace(/"/g, '""')}",${f.failedAt}`);
  }

  return lines.join("\n");
}

/**
 * Export payout statement to JSON string.
 */
export function exportStatementToJson(statement: PayoutStatement): string {
  return JSON.stringify(statement, null, 2);
}

/**
 * Payout Statement Types — Issue #245
 *
 * Defines the schema for seller payout statements, providing a single source
 * of truth for fee, refund, and settlement reconciliation data.
 */

/** The period covered by a payout statement (ISO-8601 date strings). */
export interface PayoutPeriod {
  /** Inclusive start of the period, e.g. "2024-01-01". */
  start: string;
  /** Inclusive end of the period, e.g. "2024-01-31". */
  end: string;
}

/**
 * A line-item record for a single sale within a payout statement.
 * Each entry corresponds to one confirmed purchase event.
 */
export interface SaleLineItem {
  /** Unique purchase / transaction reference. */
  purchaseId: string;
  /** Prompt that was sold. */
  promptId: string;
  /** Gross sale amount in the settlement currency (e.g. USD cents or USDC stroops). */
  grossAmount: number;
  /** Platform fee deducted from this sale. */
  platformFee: number;
  /** Net amount credited to the seller for this sale (grossAmount − platformFee). */
  netAmount: number;
  /** ISO-8601 timestamp of the purchase event. */
  purchasedAt: string;
}

/**
 * A refund line item reducing the seller's net settlement.
 * Refunds arise from fulfilled orders that were subsequently reversed.
 */
export interface RefundLineItem {
  /** Original purchase reference that was refunded. */
  purchaseId: string;
  promptId: string;
  /** Amount refunded to the buyer (debited from the seller's settlement). */
  refundAmount: number;
  /** Platform fee that was reinstated / not retained on refund. */
  feeReinstatement: number;
  /** ISO-8601 timestamp when the refund was confirmed. */
  refundedAt: string;
}

/**
 * A failed-payout record for a sale whose settlement transfer could not
 * be completed (e.g. invalid wallet, network error, insufficient liquidity).
 */
export interface FailedPayoutLineItem {
  /** Originating purchase reference. */
  purchaseId: string;
  promptId: string;
  /** Amount that could not be settled to the seller. */
  amount: number;
  /** Human-readable reason for the failure. */
  reason: string;
  /** ISO-8601 timestamp of the failed payout attempt. */
  failedAt: string;
}

/**
 * The complete payout statement for a seller over a billing period.
 *
 * All monetary amounts are expressed as **integers in the smallest currency
 * unit** (e.g. USD cents, or USDC micro-units) to avoid floating-point
 * precision errors in financial calculations.
 */
export interface PayoutStatement {
  /** Unique identifier for this statement (e.g. UUID or "stmt_<sellerId>_<period>"). */
  statementId: string;
  /** Seller whose earnings this statement covers. */
  sellerId: string;
  /** Billing period for this statement. */
  period: PayoutPeriod;

  // ── Aggregated totals ───────────────────────────────────────────────────

  /** Total number of confirmed sales in the period. */
  saleCount: number;
  /** Sum of gross sale amounts before any deductions. */
  totalSales: number;
  /**
   * Total platform fee charged across all sales.
   * platformFee = sum(sale.platformFee for each sale)
   */
  platformFee: number;
  /**
   * Total refunds issued to buyers during the period.
   * This figure is debited from the seller's settlement.
   */
  refunds: number;
  /**
   * Total amount that could not be settled due to payout failures.
   * These amounts remain in escrow pending re-attempt or manual resolution.
   */
  failedPayouts: number;
  /**
   * Final amount owed to / paid to the seller.
   *
   * netSettlement = totalSales − platformFee − refunds − failedPayouts
   */
  netSettlement: number;

  // ── Line-item detail ────────────────────────────────────────────────────

  /** Itemised sale records used to derive totalSales and platformFee. */
  sales: SaleLineItem[];
  /** Itemised refund records used to derive the refunds total. */
  refundItems: RefundLineItem[];
  /** Itemised failed-payout records used to derive failedPayouts. */
  failedPayoutItems: FailedPayoutLineItem[];

  // ── Metadata ────────────────────────────────────────────────────────────

  /** ISO-8601 timestamp when this statement was generated. */
  generatedAt: string;
  /**
   * HMAC-SHA256 signature over the statement payload (excluding this field),
   * formatted as "sha256=<hex>". Verifies statement integrity.
   */
  signature?: string;
}

/**
 * Public-safe explanation codes for review eligibility and reputation
 * decisions — Issue #109. These are the only anti-abuse signals ever
 * returned to clients; raw thresholds/policy internals stay server-side
 * (see ./reputationPolicy).
 */

export const EligibilityCode = {
  ELIGIBLE: "ELIGIBLE",
  NO_PURCHASE: "NO_PURCHASE_FOUND",
  ALREADY_REVIEWED: "PURCHASE_ALREADY_REVIEWED",
  PURCHASE_REFUNDED: "PURCHASE_REFUNDED",
  PURCHASE_FRAUD_CONFIRMED: "PURCHASE_FRAUD_CONFIRMED",
  INTERACTION_WINDOW_NOT_ELAPSED: "INTERACTION_WINDOW_NOT_ELAPSED",
  SELF_REVIEW: "SELF_REVIEW_NOT_ALLOWED",
} as const;

export type EligibilityCodeValue = (typeof EligibilityCode)[keyof typeof EligibilityCode];

export const AbuseFlagCode = {
  SELF_REVIEW: "SELF_REVIEW",
  RECIPROCAL_RING: "RECIPROCAL_RING",
  BURST_PATTERN: "BURST_PATTERN",
  LINKED_WALLET_CLUSTER: "LINKED_WALLET_CLUSTER",
  REFUND_INVALIDATED: "REFUND_INVALIDATED",
  FRAUD_CONFIRMED: "FRAUD_CONFIRMED",
} as const;

export type AbuseFlagCodeValue = (typeof AbuseFlagCode)[keyof typeof AbuseFlagCode];

export const ReputationExplanationCode = {
  LOW_SAMPLE: "LOW_SAMPLE_UNCERTAIN",
  DECAY_APPLIED: "RECENCY_DECAY_APPLIED",
  MODERATION_ADJUSTED: "MODERATION_ADJUSTED",
} as const;

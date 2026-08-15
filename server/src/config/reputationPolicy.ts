/**
 * Sybil-resistant review eligibility & reputation policy — Issue #109
 *
 * Bumping POLICY_VERSION and adding a new entry to POLICY_HISTORY lets
 * reputation snapshots stay reproducible: a snapshot always records the
 * policyVersion used to produce it, so historical snapshots remain valid
 * even after the active policy changes.
 *
 * Thresholds here are intentionally internal — routes must only ever
 * expose the explanation codes in ./explanationCodes, never these raw
 * numbers, so anti-abuse limits can't be reverse-engineered.
 */

export interface ReputationPolicy {
  version: number;
  /** Hours a buyer must hold a purchase before it becomes review-eligible. */
  interactionWindowHours: number;
  /** Reviews below this sample size get reduced confidence, not a misleading average. */
  minSampleSizeForConfidence: number;
  /** Recency weighting: a review's weight halves every N days. */
  decayHalfLifeDays: number;
  /** Window used to detect a burst of reviews aimed at one seller. */
  burstWindowMinutes: number;
  /** Distinct-wallet review count within the burst window that trips the flag. */
  burstThresholdCount: number;
  /** Window used to detect reciprocal (you-review-me-I-review-you) rings. */
  reciprocalRingWindowDays: number;
  /** Days a reviewer/flagged party has to appeal a fraud/abuse flag. */
  appealWindowDays: number;
}

const POLICY_HISTORY: Record<number, ReputationPolicy> = {
  1: {
    version: 1,
    interactionWindowHours: 24,
    minSampleSizeForConfidence: 5,
    decayHalfLifeDays: 90,
    burstWindowMinutes: 60,
    burstThresholdCount: 5,
    reciprocalRingWindowDays: 14,
    appealWindowDays: 14,
  },
};

export const POLICY_VERSION = 1;

export function getPolicy(version: number = POLICY_VERSION): ReputationPolicy {
  const policy = POLICY_HISTORY[version];
  if (!policy) {
    throw new Error(`Unknown reputation policy version: ${version}`);
  }
  return policy;
}

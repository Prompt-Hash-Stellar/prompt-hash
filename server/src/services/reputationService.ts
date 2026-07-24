/**
 * Sybil-resistant review eligibility & versioned reputation snapshots — Issue #109
 *
 * Reviews stay raw, append-only, audit-friendly records (see models/Review).
 * Reputation is a separate, derived, versioned artifact (ReputationSnapshot)
 * recomputed whenever something changes the eligible input set (a review is
 * added/edited/deleted, a purchase is refunded, fraud is confirmed, or an
 * appeal is resolved). Past snapshots are never mutated — only superseded —
 * so history can't be silently rewritten.
 */
import { createHash } from "crypto";
import Prompt from "../models/Prompt";
import Purchase from "../models/Purchase";
import Review from "../models/Review";
import ReviewFlag from "../models/ReviewFlag";
import ReviewAppeal from "../models/ReviewAppeal";
import ReputationSnapshot from "../models/ReputationSnapshot";
import FulfillmentRecord from "../models/FulfillmentRecord";
import { getPolicy, POLICY_VERSION } from "../config/reputationPolicy";
import { EligibilityCode, AbuseFlagCode } from "../config/explanationCodes";

export class ReputationError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function getPromptWithSeller(promptId: string) {
  const prompt = await Prompt.findById(promptId).populate("owner", "walletAddress").lean();
  return prompt as any;
}

async function isPurchaseRefunded(promptId: string, buyerWallet: string): Promise<boolean> {
  const record = await FulfillmentRecord.findOne({
    promptId,
    buyerWallet: buyerWallet.toLowerCase(),
  }).lean();
  return record?.status === "refunded";
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface EligibilityResult {
  eligible: boolean;
  code: string;
  prompt?: any;
  purchase?: any;
  sellerWallet?: string;
}

export async function checkReviewEligibility(
  promptId: string,
  reviewerWallet: string,
  policyVersion: number = POLICY_VERSION,
): Promise<EligibilityResult> {
  const policy = getPolicy(policyVersion);
  const wallet = reviewerWallet.toLowerCase();

  const prompt = await getPromptWithSeller(promptId);
  if (!prompt) {
    return { eligible: false, code: EligibilityCode.NO_PURCHASE };
  }

  const sellerWallet = (prompt.owner?.walletAddress ?? "").toLowerCase();
  if (sellerWallet && sellerWallet === wallet) {
    return { eligible: false, code: EligibilityCode.SELF_REVIEW, prompt, sellerWallet };
  }

  const purchase = await Purchase.findOne({ promptId, buyerWallet: wallet })
    .sort({ createdAt: -1 })
    .lean();

  if (!purchase) {
    return { eligible: false, code: EligibilityCode.NO_PURCHASE, prompt, sellerWallet };
  }

  if ((purchase as any).fraudConfirmed) {
    return {
      eligible: false,
      code: EligibilityCode.PURCHASE_FRAUD_CONFIRMED,
      prompt,
      purchase,
      sellerWallet,
    };
  }

  if (await isPurchaseRefunded(promptId, wallet)) {
    return {
      eligible: false,
      code: EligibilityCode.PURCHASE_REFUNDED,
      prompt,
      purchase,
      sellerWallet,
    };
  }

  const existingReview = await Review.findOne({
    purchaseId: purchase._id,
    status: { $ne: "deleted" },
  }).lean();
  if (existingReview) {
    return {
      eligible: false,
      code: EligibilityCode.ALREADY_REVIEWED,
      prompt,
      purchase,
      sellerWallet,
    };
  }

  const purchasedAt = new Date((purchase as any).createdAt).getTime();
  const windowMs = policy.interactionWindowHours * 60 * 60 * 1000;
  if (Date.now() - purchasedAt < windowMs) {
    return {
      eligible: false,
      code: EligibilityCode.INTERACTION_WINDOW_NOT_ELAPSED,
      prompt,
      purchase,
      sellerWallet,
    };
  }

  return { eligible: true, code: EligibilityCode.ELIGIBLE, prompt, purchase, sellerWallet };
}

// ---------------------------------------------------------------------------
// Abuse signal detection (privacy-conscious: only hashes/equality checks,
// never raw linkage data, are ever returned to callers)
// ---------------------------------------------------------------------------

export async function detectAbuseSignals(params: {
  promptId: string;
  reviewerWallet: string;
  sellerWallet: string;
  purchase: any;
  policyVersion?: number;
}): Promise<string[]> {
  const policy = getPolicy(params.policyVersion ?? POLICY_VERSION);
  const reviewerWallet = params.reviewerWallet.toLowerCase();
  const sellerWallet = params.sellerWallet.toLowerCase();
  const flags: string[] = [];

  const sellerPrompts = await Prompt.find({ owner: { $exists: true } })
    .populate("owner", "walletAddress")
    .lean();
  const sellerPromptIds = sellerPrompts
    .filter((p: any) => (p.owner?.walletAddress ?? "").toLowerCase() === sellerWallet)
    .map((p: any) => String(p._id));
  const reviewerPromptIds = sellerPrompts
    .filter((p: any) => (p.owner?.walletAddress ?? "").toLowerCase() === reviewerWallet)
    .map((p: any) => String(p._id));

  // Reciprocal ring: the seller (or another wallet the seller controls a
  // prompt for) has reviewed something the reviewer owns, and vice versa.
  if (reviewerPromptIds.length > 0) {
    const ringWindowStart = new Date(
      Date.now() - policy.reciprocalRingWindowDays * 24 * 60 * 60 * 1000,
    );
    const reciprocal = await Review.findOne({
      promptId: { $in: reviewerPromptIds },
      userAddress: sellerWallet,
      status: { $ne: "deleted" },
      createdAt: { $gte: ringWindowStart },
    }).lean();
    if (reciprocal) flags.push(AbuseFlagCode.RECIPROCAL_RING);
  }

  // Burst pattern: many distinct-wallet reviews landing on this seller's
  // prompts within a short window.
  if (sellerPromptIds.length > 0) {
    const burstWindowStart = new Date(Date.now() - policy.burstWindowMinutes * 60 * 1000);
    const recentReviewers = await Review.find({
      promptId: { $in: sellerPromptIds },
      status: { $ne: "deleted" },
      createdAt: { $gte: burstWindowStart },
    }).distinct("userAddress");
    if (recentReviewers.length >= policy.burstThresholdCount) {
      flags.push(AbuseFlagCode.BURST_PATTERN);
    }
  }

  // Linked-wallet cluster: other reviewers of this seller share the same
  // funding-source hash as this purchase (a privacy-conscious clustering
  // key — never a raw address).
  const fundingHash = params.purchase?.fundingSourceHash;
  if (fundingHash && sellerPromptIds.length > 0) {
    const clusterBuyers = await Purchase.find({
      promptId: { $in: sellerPromptIds },
      fundingSourceHash: fundingHash,
    }).distinct("buyerWallet");
    const distinctOthers = new Set(
      clusterBuyers.map((w: string) => w.toLowerCase()).filter((w: string) => w !== reviewerWallet),
    );
    if (distinctOthers.size > 0) flags.push(AbuseFlagCode.LINKED_WALLET_CLUSTER);
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Review lifecycle
// ---------------------------------------------------------------------------

export async function submitReview(params: {
  promptId: string;
  reviewerWallet: string;
  rating: number;
  text?: string;
}) {
  const wallet = params.reviewerWallet.toLowerCase();
  const eligibility = await checkReviewEligibility(params.promptId, wallet);
  if (!eligibility.eligible) {
    throw new ReputationError(eligibility.code, `Review not eligible: ${eligibility.code}`, 403);
  }

  const review = await Review.create({
    promptId: params.promptId,
    userAddress: wallet,
    purchaseId: eligibility.purchase._id,
    rating: params.rating,
    text: params.text ?? "",
    verified: true,
    status: "active",
    version: 1,
  });

  const flagCodes = await detectAbuseSignals({
    promptId: params.promptId,
    reviewerWallet: wallet,
    sellerWallet: eligibility.sellerWallet ?? "",
    purchase: eligibility.purchase,
  });

  for (const code of flagCodes) {
    await ReviewFlag.create({
      reviewId: review._id,
      promptId: params.promptId,
      sellerWallet: eligibility.sellerWallet ?? "",
      reviewerWallet: wallet,
      code,
      status: "active",
    });
  }

  const snapshot = await recomputeReputationSnapshot(eligibility.sellerWallet ?? "", "review_added");

  return { review, flagCodes, snapshot };
}

export async function editReview(params: {
  reviewId: string;
  reviewerWallet: string;
  rating: number;
  text?: string;
}) {
  const review = await Review.findById(params.reviewId);
  if (!review) throw new ReputationError("REVIEW_NOT_FOUND", "Review not found", 404);
  if (review.userAddress !== params.reviewerWallet.toLowerCase() || review.status === "deleted") {
    throw new ReputationError("NOT_ALLOWED", "You cannot edit this review", 403);
  }

  review.history.push({ rating: review.rating, text: review.text, editedAt: new Date() });
  review.rating = params.rating;
  review.text = params.text ?? review.text;
  review.status = "edited";
  review.version += 1;
  await review.save();

  const prompt = await getPromptWithSeller(review.promptId);
  const sellerWallet = (prompt?.owner?.walletAddress ?? "").toLowerCase();
  const snapshot = await recomputeReputationSnapshot(sellerWallet, "review_edited");

  return { review, snapshot };
}

export async function deleteReview(params: { reviewId: string; reviewerWallet: string }) {
  const review = await Review.findById(params.reviewId);
  if (!review) throw new ReputationError("REVIEW_NOT_FOUND", "Review not found", 404);
  if (review.userAddress !== params.reviewerWallet.toLowerCase()) {
    throw new ReputationError("NOT_ALLOWED", "You cannot delete this review", 403);
  }

  review.status = "deleted";
  review.deletedAt = new Date();
  await review.save();

  const prompt = await getPromptWithSeller(review.promptId);
  const sellerWallet = (prompt?.owner?.walletAddress ?? "").toLowerCase();
  const snapshot = await recomputeReputationSnapshot(sellerWallet, "review_deleted");

  return { review, snapshot };
}

export async function markPurchaseFraud(purchaseId: string) {
  const purchase = await Purchase.findByIdAndUpdate(
    purchaseId,
    { fraudConfirmed: true, fraudConfirmedAt: new Date() },
    { new: true },
  ).lean();
  if (!purchase) throw new ReputationError("PURCHASE_NOT_FOUND", "Purchase not found", 404);

  return invalidateReviewForPurchase(purchase as any, "FRAUD_CONFIRMED", "fraud_confirmed");
}

export async function invalidateReviewForRefund(promptId: string, buyerWallet: string) {
  const purchase = await Purchase.findOne({
    promptId,
    buyerWallet: buyerWallet.toLowerCase(),
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!purchase) return null;

  return invalidateReviewForPurchase(purchase as any, "REFUND_INVALIDATED", "refund");
}

async function invalidateReviewForPurchase(
  purchase: any,
  flagCode: "REFUND_INVALIDATED" | "FRAUD_CONFIRMED",
  reason: "refund" | "fraud_confirmed",
) {
  const review = await Review.findOne({
    purchaseId: purchase._id,
    status: { $ne: "deleted" },
  });

  const prompt = await getPromptWithSeller(purchase.promptId);
  const sellerWallet = (prompt?.owner?.walletAddress ?? "").toLowerCase();

  if (review) {
    await ReviewFlag.create({
      reviewId: review._id,
      promptId: purchase.promptId,
      sellerWallet,
      reviewerWallet: purchase.buyerWallet,
      code: flagCode,
      status: "active",
    });
  }

  const snapshot = await recomputeReputationSnapshot(sellerWallet, reason);
  return { review, snapshot };
}

// ---------------------------------------------------------------------------
// Appeals (with reviewer/seller conflict-of-interest control)
// ---------------------------------------------------------------------------

export async function fileAppeal(params: {
  flagId: string;
  appellantWallet: string;
  reason: string;
}) {
  const flag = await ReviewFlag.findById(params.flagId);
  if (!flag) throw new ReputationError("FLAG_NOT_FOUND", "Flag not found", 404);

  const appeal = await ReviewAppeal.create({
    flagId: flag._id,
    reviewId: flag.reviewId,
    appellantWallet: params.appellantWallet.toLowerCase(),
    reason: params.reason,
    status: "pending",
  });

  flag.status = "appealed";
  await flag.save();

  return appeal;
}

export async function resolveAppeal(params: {
  appealId: string;
  resolverWallet: string;
  approve: boolean;
  note?: string;
}) {
  const appeal = await ReviewAppeal.findById(params.appealId);
  if (!appeal) throw new ReputationError("APPEAL_NOT_FOUND", "Appeal not found", 404);

  const flag = await ReviewFlag.findById(appeal.flagId);
  if (!flag) throw new ReputationError("FLAG_NOT_FOUND", "Flag not found", 404);

  const resolver = params.resolverWallet.toLowerCase();
  if (resolver === appeal.appellantWallet || resolver === flag.reviewerWallet) {
    throw new ReputationError(
      "CONFLICT_OF_INTEREST",
      "The reviewer or appellant cannot resolve their own appeal",
      403,
    );
  }
  if (flag.sellerWallet && resolver === flag.sellerWallet) {
    throw new ReputationError(
      "CONFLICT_OF_INTEREST",
      "The affected seller cannot resolve this appeal",
      403,
    );
  }

  appeal.status = params.approve ? "approved" : "denied";
  appeal.resolvedBy = resolver;
  appeal.resolvedAt = new Date();
  appeal.resolutionNote = params.note ?? "";
  await appeal.save();

  flag.status = params.approve ? "overturned" : "upheld";
  await flag.save();

  const snapshot = await recomputeReputationSnapshot(flag.sellerWallet, "appeal_resolved");
  return { appeal, flag, snapshot };
}

// ---------------------------------------------------------------------------
// Reputation computation
// ---------------------------------------------------------------------------

export interface ComputedReputation {
  sellerWallet: string;
  policyVersion: number;
  sampleSize: number;
  excludedCount: number;
  rawAverage: number;
  weightedScore: number;
  confidence: number;
  decayHalfLifeDays: number;
  inputsHash: string;
  explanationCodes: string[];
  asOf: Date;
}

/**
 * Pure(ish) computation over current DB state: given the same seller,
 * policy version, and `asOf` timestamp, this always returns the same
 * result — required for deterministic snapshot rebuilds.
 */
export async function computeReputation(
  sellerWallet: string,
  options: { asOf?: Date; policyVersion?: number } = {},
): Promise<ComputedReputation> {
  const policyVersion = options.policyVersion ?? POLICY_VERSION;
  const policy = getPolicy(policyVersion);
  const asOf = options.asOf ?? new Date();
  const wallet = sellerWallet.toLowerCase();

  const sellerPrompts = await Prompt.find({}).populate("owner", "walletAddress").lean();
  const sellerPromptIds = sellerPrompts
    .filter((p: any) => (p.owner?.walletAddress ?? "").toLowerCase() === wallet)
    .map((p: any) => String(p._id));

  const reviews = sellerPromptIds.length
    ? await Review.find({
        promptId: { $in: sellerPromptIds },
        status: { $in: ["active", "edited"] },
        createdAt: { $lte: asOf },
      }).lean()
    : [];

  const activeFlags = await ReviewFlag.find({
    reviewId: { $in: reviews.map((r: any) => r._id) },
    status: { $in: ["active", "upheld"] },
  }).distinct("reviewId");
  const excludedReviewIds = new Set(activeFlags.map((id: any) => String(id)));

  const eligibleReviews = reviews.filter((r: any) => !excludedReviewIds.has(String(r._id)));
  const excludedCount = reviews.length - eligibleReviews.length;

  let weightSum = 0;
  let weightedRatingSum = 0;
  let rawSum = 0;

  for (const review of eligibleReviews) {
    const ageMs = asOf.getTime() - new Date((review as any).createdAt).getTime();
    const ageDays = Math.max(0, ageMs / (24 * 60 * 60 * 1000));
    const weight = Math.pow(0.5, ageDays / policy.decayHalfLifeDays);
    weightSum += weight;
    weightedRatingSum += weight * (review as any).rating;
    rawSum += (review as any).rating;
  }

  const sampleSize = eligibleReviews.length;
  const rawAverage = sampleSize > 0 ? rawSum / sampleSize : 0;
  const weightedScore = weightSum > 0 ? weightedRatingSum / weightSum : 0;
  const confidence = Math.min(1, sampleSize / policy.minSampleSizeForConfidence);

  const explanationCodes: string[] = [];
  if (confidence < 1) explanationCodes.push("LOW_SAMPLE_UNCERTAIN");
  if (sampleSize > 0) explanationCodes.push("RECENCY_DECAY_APPLIED");
  if (excludedCount > 0) explanationCodes.push("MODERATION_ADJUSTED");

  const inputsForHash = eligibleReviews
    .map((r: any) => ({
      id: String(r._id),
      rating: r.rating,
      createdAt: new Date(r.createdAt).getTime(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const inputsHash = sha256Hex(JSON.stringify({ policyVersion, inputsForHash }));

  return {
    sellerWallet: wallet,
    policyVersion,
    sampleSize,
    excludedCount,
    rawAverage,
    weightedScore,
    confidence,
    decayHalfLifeDays: policy.decayHalfLifeDays,
    inputsHash,
    explanationCodes,
    asOf,
  };
}

export async function recomputeReputationSnapshot(
  sellerWallet: string,
  reason:
    | "review_added"
    | "review_edited"
    | "review_deleted"
    | "refund"
    | "fraud_confirmed"
    | "appeal_resolved"
    | "policy_upgrade"
    | "manual_rebuild",
  options: { asOf?: Date; policyVersion?: number } = {},
) {
  if (!sellerWallet) return null;

  const computed = await computeReputation(sellerWallet, options);

  const previous = await ReputationSnapshot.findOne({ sellerWallet: computed.sellerWallet })
    .sort({ snapshotVersion: -1 })
    .lean();

  const snapshot = await ReputationSnapshot.create({
    sellerWallet: computed.sellerWallet,
    snapshotVersion: previous ? (previous as any).snapshotVersion + 1 : 1,
    policyVersion: computed.policyVersion,
    previousSnapshotId: previous ? (previous as any)._id : null,
    reason,
    sampleSize: computed.sampleSize,
    excludedCount: computed.excludedCount,
    rawAverage: computed.rawAverage,
    weightedScore: computed.weightedScore,
    confidence: computed.confidence,
    decayHalfLifeDays: computed.decayHalfLifeDays,
    inputsHash: computed.inputsHash,
    explanationCodes: computed.explanationCodes,
    asOf: computed.asOf,
  });

  return snapshot;
}

export async function getLatestSnapshot(sellerWallet: string) {
  return ReputationSnapshot.findOne({ sellerWallet: sellerWallet.toLowerCase() })
    .sort({ snapshotVersion: -1 })
    .lean();
}

export async function getSnapshotHistory(sellerWallet: string) {
  return ReputationSnapshot.find({ sellerWallet: sellerWallet.toLowerCase() })
    .sort({ snapshotVersion: -1 })
    .lean();
}

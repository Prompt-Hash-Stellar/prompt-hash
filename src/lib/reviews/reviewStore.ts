/**
 * Shared In-Memory Review Storage & Moderation Engine
 * 
 * Provides unified access to prompt reviews, report management, and
 * maintainer moderation workflows with clean status separation.
 */

export type ReviewStatus = "visible" | "hidden" | "flagged" | "pending";

export interface ReviewReport {
  reporterAddress: string;
  reason: string;
  createdAt: number;
}

export interface StoredReview {
  id: string;
  promptId: string;
  userAddress: string;
  rating: number;
  text: string;
  createdAt: number;
  updatedAt: number;
  verified: boolean;
  status: ReviewStatus;
  reports: ReviewReport[];
  reportCount: number;
}

export interface PublicReview {
  id: string;
  promptId: string;
  userAddress: string;
  rating: number;
  text: string;
  createdAt: number;
  verified: boolean;
  status: ReviewStatus;
}

// Global review map keyed by promptId
const reviewStorage = new Map<string, StoredReview[]>();

// Initial mock seed
function seedMockReviews(): void {
  const now = Date.now();
  const mockReviews: StoredReview[] = [
    {
      id: "review_1",
      promptId: "1",
      userAddress: "GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZ",
      rating: 5,
      text: "Excellent prompt! Helped me generate high-quality technical documentation in minutes. The structure and clarity are outstanding.",
      createdAt: now - 86400000 * 2,
      updatedAt: now - 86400000 * 2,
      verified: true,
      status: "visible",
      reports: [],
      reportCount: 0,
    },
    {
      id: "review_2",
      promptId: "1",
      userAddress: "GBCD234ABC567EFG890HIJ123KLM456NOP789QRS012TUV345WXY678ZA",
      rating: 4,
      text: "Very useful for system design work. Could use a bit more detail on edge cases, but overall a solid prompt.",
      createdAt: now - 86400000 * 5,
      updatedAt: now - 86400000 * 5,
      verified: true,
      status: "visible",
      reports: [],
      reportCount: 0,
    },
    {
      id: "review_3",
      promptId: "2",
      userAddress: "GCDE345BCD678FGH901IJK234LMN567OPQ890RST123UVW456XYZ789AB",
      rating: 5,
      text: "Amazing for creative writing! The narrative structures it generates are incredibly detailed and engaging. Worth every XLM.",
      createdAt: now - 86400000 * 1,
      updatedAt: now - 86400000 * 1,
      verified: true,
      status: "visible",
      reports: [],
      reportCount: 0,
    },
  ];

  for (const review of mockReviews) {
    const existing = reviewStorage.get(review.promptId) ?? [];
    existing.push(review);
    reviewStorage.set(review.promptId, existing);
  }
}

// Seed on module load
if (reviewStorage.size === 0) {
  seedMockReviews();
}

/**
 * Strips internal moderation metadata before returning to public buyers.
 */
export function toPublicReview(review: StoredReview): PublicReview {
  return {
    id: review.id,
    promptId: review.promptId,
    userAddress: review.userAddress,
    rating: review.rating,
    text: review.text,
    createdAt: review.createdAt,
    verified: review.verified,
    status: review.status,
  };
}

/**
 * Returns public visible (or flagged) reviews for a prompt.
 * Hidden reviews are excluded from normal buyer views.
 */
export function getPublicReviews(promptId: string): PublicReview[] {
  const reviews = reviewStorage.get(String(promptId)) ?? [];
  return reviews
    .filter((r) => r.status !== "hidden")
    .map(toPublicReview)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Internal method to fetch raw reviews including hidden/flagged metadata.
 */
export function getAllReviewsForPrompt(promptId: string): StoredReview[] {
  return reviewStorage.get(String(promptId)) ?? [];
}

/**
 * Check if a wallet has already submitted a review for a prompt.
 */
export function hasUserReviewed(promptId: string, userAddress: string): boolean {
  const reviews = reviewStorage.get(String(promptId)) ?? [];
  return reviews.some((r) => r.userAddress.toLowerCase() === userAddress.toLowerCase());
}

/**
 * Add a new review.
 */
export function addReview(
  promptId: string,
  userAddress: string,
  rating: number,
  text: string,
): StoredReview {
  if (hasUserReviewed(promptId, userAddress)) {
    throw new Error("You have already reviewed this prompt");
  }

  const now = Date.now();
  const review: StoredReview = {
    id: `review_${now}_${Math.random().toString(36).slice(2, 9)}`,
    promptId: String(promptId),
    userAddress,
    rating,
    text: text.trim(),
    createdAt: now,
    updatedAt: now,
    verified: true,
    status: "visible",
    reports: [],
    reportCount: 0,
  };

  const existing = reviewStorage.get(String(promptId)) ?? [];
  existing.push(review);
  reviewStorage.set(String(promptId), existing);
  return review;
}

/**
 * Report a review for moderation. Sets status to "flagged".
 */
export function reportReview(
  reviewId: string,
  promptId: string,
  reporterAddress: string,
  reason: string,
): StoredReview {
  const reviews = reviewStorage.get(String(promptId)) ?? [];
  const review = reviews.find((r) => r.id === reviewId);

  if (!review) {
    throw new Error("Review not found");
  }

  const alreadyReported = review.reports.some(
    (rep) => rep.reporterAddress.toLowerCase() === reporterAddress.toLowerCase(),
  );

  if (alreadyReported) {
    throw new Error("You have already reported this review");
  }

  const report: ReviewReport = {
    reporterAddress,
    reason: reason.trim(),
    createdAt: Date.now(),
  };

  review.reports.push(report);
  review.reportCount += 1;
  review.status = "flagged";
  review.updatedAt = Date.now();

  return review;
}

/**
 * Moderate a review (hide, unhide, dismiss_reports).
 */
export function moderateReview(
  reviewId: string,
  promptId: string,
  action: "hide" | "unhide" | "dismiss_reports",
): StoredReview {
  const reviews = reviewStorage.get(String(promptId)) ?? [];
  const review = reviews.find((r) => r.id === reviewId);

  if (!review) {
    throw new Error("Review not found");
  }

  if (action === "hide") {
    review.status = "hidden";
  } else if (action === "unhide") {
    review.status = "visible";
  } else if (action === "dismiss_reports") {
    review.status = "visible";
    review.reports = [];
    review.reportCount = 0;
  }

  review.updatedAt = Date.now();
  return review;
}

/**
 * Reset store (primarily for unit testing).
 */
export function resetReviewStore(): void {
  reviewStorage.clear();
  seedMockReviews();
}

/**
 * Review Client
 * 
 * Client-side API for submitting, fetching, reporting, and moderating prompt reviews.
 */

export type ReviewStatus = "visible" | "hidden" | "flagged" | "pending";

export interface Review {
  id: string;
  promptId: string;
  userAddress: string;
  rating: number;
  text: string;
  createdAt: number;
  verified: boolean;
  status?: ReviewStatus;
}

export interface ReviewStats {
  total: number;
  averageRating: number;
  distribution: {
    5: number;
    4: number;
    3: number;
    2: number;
    1: number;
  };
}

export interface ReviewListResponse {
  reviews: Review[];
  stats: ReviewStats;
}

const API_BASE = "/api/reviews";

export class ReviewClient {
  /**
   * Submit a new review for a prompt
   */
  static async submitReview(
    promptId: string,
    userAddress: string,
    rating: number,
    text: string,
    signature: string = ""
  ): Promise<{ success: boolean; review: { id: string; rating: number; createdAt: number; status?: ReviewStatus } }> {
    const response = await fetch(`${API_BASE}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        promptId,
        userAddress,
        rating,
        text,
        signature,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to submit review");
    }

    return response.json();
  }

  /**
   * Get all visible reviews for a prompt
   */
  static async getReviews(promptId: string): Promise<ReviewListResponse> {
    const response = await fetch(`${API_BASE}/list?promptId=${promptId}`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to fetch reviews");
    }

    return response.json();
  }

  /**
   * Get review statistics for a prompt
   */
  static async getReviewStats(promptId: string): Promise<ReviewStats> {
    const data = await this.getReviews(promptId);
    return data.stats;
  }

  /**
   * Report a review for moderation
   */
  static async reportReview(
    reviewId: string,
    promptId: string,
    reporterAddress: string,
    reason: string
  ): Promise<{ success: boolean; message: string; reviewId: string; status: ReviewStatus }> {
    const response = await fetch(`${API_BASE}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewId,
        promptId,
        reporterAddress,
        reason,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to report review");
    }

    return response.json();
  }

  /**
   * Maintainer/Admin moderation action
   */
  static async moderateReview(
    reviewId: string,
    promptId: string,
    action: "hide" | "unhide" | "dismiss_reports",
    adminAddress: string,
    adminSecretKey?: string
  ): Promise<{ success: boolean; action: string; review: { id: string; status: ReviewStatus } }> {
    const response = await fetch(`${API_BASE}/moderate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reviewId,
        promptId,
        action,
        adminAddress,
        adminSecretKey,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to moderate review");
    }

    return response.json();
  }
}

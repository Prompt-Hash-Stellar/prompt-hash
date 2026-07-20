/**
 * Review Report Endpoint
 * 
 * Allows users to report a review for moderation due to spam, abuse, or inaccuracy.
 * Flags the review for maintainer/admin moderation without silently removing it.
 */

import { reportReview } from "../../src/lib/reviews/reviewStore";

export interface ReportReviewRequest {
  reviewId: string;
  promptId: string;
  reporterAddress: string;
  reason: string;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { reviewId, promptId, reporterAddress, reason }: ReportReviewRequest = req.body ?? {};

  if (!reviewId || !promptId || !reporterAddress || !reason) {
    res.status(400).json({ error: "reviewId, promptId, reporterAddress, and reason are required" });
    return;
  }

  if (reason.trim().length < 5) {
    res.status(400).json({ error: "Reason must be at least 5 characters long" });
    return;
  }

  try {
    const updatedReview = reportReview(
      String(reviewId),
      String(promptId),
      String(reporterAddress),
      reason.trim(),
    );

    console.log(`✓ Review ${reviewId} reported by ${reporterAddress.slice(0, 8)}... Reason: ${reason}`);

    res.status(200).json({
      success: true,
      message: "Review reported for moderation",
      reviewId: updatedReview.id,
      status: updatedReview.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to report review";
    console.error("Report review error:", message);
    if (message.includes("already reported")) {
      res.status(409).json({ error: message });
    } else if (message.includes("not found")) {
      res.status(404).json({ error: message });
    } else {
      res.status(500).json({ error: message });
    }
  }
}

import express, { Request, Response } from "express";
import connectDb from "../db/connectDb";
import Review from "../models/Review";
import { cacheDel } from "../services/cacheService";
import { CACHE_KEYS } from "../services/cacheService";
import {
  submitReview,
  editReview,
  deleteReview,
  ReputationError,
} from "../services/reputationService";

export const reviewRouter = express.Router();

// POST /api/reviews/submit
reviewRouter.post("/submit", async (req: Request, res: Response) => {
  try {
    await connectDb();

    const { promptId, userAddress, rating, text } = req.body as {
      promptId?: string;
      userAddress?: string;
      rating?: number;
      text?: string;
    };

    if (!promptId || !userAddress || !rating) {
      return res.status(400).json({ error: "promptId, userAddress and rating are required" });
    }

    if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({ error: "rating must be an integer between 1 and 5" });
    }

    const { review, flagCodes } = await submitReview({
      promptId,
      reviewerWallet: userAddress,
      rating,
      text,
    });

    await cacheDel(CACHE_KEYS.promptDetail(promptId));

    return res.json({
      success: true,
      review: { id: review._id, rating: review.rating, createdAt: review.createdAt },
      flagCodes,
    });
  } catch (err) {
    if (err instanceof ReputationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("Review submit error:", err);
    return res.status(500).json({ error: "Failed to submit review" });
  }
});

// PUT /api/reviews/:reviewId — edit an existing review (creates a new
// reputation snapshot rather than silently rewriting past ones, #109).
reviewRouter.put("/:reviewId", async (req: Request, res: Response) => {
  try {
    await connectDb();

    const { reviewId } = req.params;
    const { userAddress, rating, text } = req.body as {
      userAddress?: string;
      rating?: number;
      text?: string;
    };

    if (!userAddress || !rating) {
      return res.status(400).json({ error: "userAddress and rating are required" });
    }
    if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({ error: "rating must be an integer between 1 and 5" });
    }

    const { review } = await editReview({ reviewId, reviewerWallet: userAddress, rating, text });

    await cacheDel(CACHE_KEYS.promptDetail(review.promptId));

    return res.json({ success: true, review: { id: review._id, rating: review.rating, status: review.status } });
  } catch (err) {
    if (err instanceof ReputationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("Review edit error:", err);
    return res.status(500).json({ error: "Failed to edit review" });
  }
});

// DELETE /api/reviews/:reviewId — soft delete (audit trail preserved, #109)
reviewRouter.delete("/:reviewId", async (req: Request, res: Response) => {
  try {
    await connectDb();

    const { reviewId } = req.params;
    const { userAddress } = req.body as { userAddress?: string };
    if (!userAddress) {
      return res.status(400).json({ error: "userAddress is required" });
    }

    const { review } = await deleteReview({ reviewId, reviewerWallet: userAddress });

    await cacheDel(CACHE_KEYS.promptDetail(review.promptId));

    return res.json({ success: true, review: { id: review._id, status: review.status } });
  } catch (err) {
    if (err instanceof ReputationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("Review delete error:", err);
    return res.status(500).json({ error: "Failed to delete review" });
  }
});

// GET /api/reviews/list?promptId=X
reviewRouter.get("/list", async (req: Request, res: Response) => {
  try {
    await connectDb();

    const { promptId } = req.query as { promptId?: string };
    if (!promptId) return res.status(400).json({ error: "promptId is required" });

    const reviews = await Review.find({ promptId, status: { $ne: "deleted" } })
      .sort({ createdAt: -1 })
      .lean();

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    for (const r of reviews) {
      distribution[r.rating] = (distribution[r.rating] ?? 0) + 1;
      sum += r.rating;
    }

    const stats = {
      total: reviews.length,
      averageRating: reviews.length ? sum / reviews.length : 0,
      distribution,
    };

    return res.json({
      reviews: reviews.map((r) => ({
        id: r._id,
        promptId: r.promptId,
        userAddress: r.userAddress,
        rating: r.rating,
        text: r.text,
        createdAt: new Date(r.createdAt as Date).getTime(),
        verified: r.verified,
        status: r.status,
      })),
      stats,
    });
  } catch (err) {
    console.error("Review list error:", err);
    return res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

import { Router, Request, Response } from "express";
import connectDb from "../db/connectDb";
import {
  getLatestSnapshot,
  getSnapshotHistory,
  markPurchaseFraud,
  fileAppeal,
  resolveAppeal,
  ReputationError,
} from "../services/reputationService";

export const reputationRouter = Router();

function handleError(res: Response, err: unknown, fallback: string) {
  if (err instanceof ReputationError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

/**
 * GET /api/reputation/:sellerWallet
 * Latest reputation snapshot for a creator — score, confidence, and
 * explanation codes only. No raw anti-abuse thresholds are ever returned.
 */
reputationRouter.get("/:sellerWallet", async (req: Request, res: Response) => {
  try {
    await connectDb();
    const snapshot = await getLatestSnapshot(req.params.sellerWallet);
    if (!snapshot) {
      return res.status(404).json({ error: "No reputation snapshot found for this seller" });
    }
    return res.json({ snapshot });
  } catch (err) {
    return handleError(res, err, "Failed to fetch reputation snapshot");
  }
});

/**
 * GET /api/reputation/:sellerWallet/history
 * Full versioned snapshot history for a creator (auditability, #109).
 */
reputationRouter.get("/:sellerWallet/history", async (req: Request, res: Response) => {
  try {
    await connectDb();
    const snapshots = await getSnapshotHistory(req.params.sellerWallet);
    return res.json({ snapshots });
  } catch (err) {
    return handleError(res, err, "Failed to fetch reputation history");
  }
});

/**
 * POST /api/reputation/purchases/:purchaseId/fraud
 * Marks a purchase as confirmed fraud, invalidating any review tied to it
 * through a new auditable snapshot (moderator/admin action).
 */
reputationRouter.post("/purchases/:purchaseId/fraud", async (req: Request, res: Response) => {
  try {
    await connectDb();
    const result = await markPurchaseFraud(req.params.purchaseId);
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err, "Failed to mark purchase as fraud");
  }
});

/**
 * POST /api/reputation/appeals
 * Body: { flagId, appellantWallet, reason }
 */
reputationRouter.post("/appeals", async (req: Request, res: Response) => {
  try {
    await connectDb();
    const { flagId, appellantWallet, reason } = req.body as {
      flagId?: string;
      appellantWallet?: string;
      reason?: string;
    };
    if (!flagId || !appellantWallet || !reason) {
      return res.status(400).json({ error: "flagId, appellantWallet and reason are required" });
    }
    const appeal = await fileAppeal({ flagId, appellantWallet, reason });
    return res.status(201).json({ success: true, appeal });
  } catch (err) {
    return handleError(res, err, "Failed to file appeal");
  }
});

/**
 * POST /api/reputation/appeals/:appealId/resolve
 * Body: { resolverWallet, approve, note? }
 * Rejects resolution attempts from the reviewer, appellant, or affected
 * seller — reviewer conflict-of-interest control (#109).
 */
reputationRouter.post("/appeals/:appealId/resolve", async (req: Request, res: Response) => {
  try {
    await connectDb();
    const { resolverWallet, approve, note } = req.body as {
      resolverWallet?: string;
      approve?: boolean;
      note?: string;
    };
    if (!resolverWallet || typeof approve !== "boolean") {
      return res.status(400).json({ error: "resolverWallet and approve are required" });
    }
    const result = await resolveAppeal({
      appealId: req.params.appealId,
      resolverWallet,
      approve,
      note,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return handleError(res, err, "Failed to resolve appeal");
  }
});

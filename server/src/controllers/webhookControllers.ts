import { Request, Response } from "express";
import connectDb from "../db/connectDb";
import WebhookSubscription from "../models/WebhookSubscription";
import {
  registerOrUpdateWebhook,
  WebhookUpdateConflictError,
} from "../services/webhookSubscriptionService";

export const RegisterWebhook = async (req: Request, res: Response): Promise<Response> => {
  try {
    await connectDb();
    const { url, events } = req.body;

    if (!url) {
      return res.status(400).json({ error: "url is required." });
    }

    const ssrfCheck = await validateWebhookUrl(url);
    if (!ssrfCheck.valid) {
      return res.status(400).json({ error: "Invalid or blocked webhook destination URL." });
    }

    const result = await registerOrUpdateWebhook({ walletAddress, url, events });

    return res.status(result.status).json({
      message: result.message,
      id: result.id,
      secret: result.secret,
      secretRotated: result.secretRotated,
      previousSecretExpiresAt: result.previousSecretExpiresAt,
    });
  } catch (err) {
    if (err instanceof WebhookUpdateConflictError) {
      return res.status(409).json({ error: err.message });
    }
    return res.status(500).json({ error: (err as Error).message });
  }
};

export const GetWebhook = async (req: Request, res: Response): Promise<Response> => {
  try {
    await connectDb();
    // Admin may query any wallet when authorized
    if (isAdminRequest(req)) {
      const { walletAddress } = req.query;
      if (!walletAddress) return res.status(400).json({ error: "walletAddress query param is required." });
      const sub = await WebhookSubscription.findOne({ walletAddress: String(walletAddress).toLowerCase() }).select("-secret");
      if (!sub) return res.status(404).json({ error: "No webhook registered for this wallet." });
      return res.json(sub);
    }

    const sub = await WebhookSubscription.findOne({
      walletAddress: String(walletAddress).toLowerCase(),
    }).select("-secret -previousSecrets");

    if (!sub) return res.status(404).json({ error: "No webhook registered for this wallet." });
    return res.json(sub);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
};

export const DeleteWebhook = async (req: Request, res: Response): Promise<Response> => {
  try {
    await connectDb();
    // Admin may delete any subscription when authorized
    if (isAdminRequest(req) && (req.body as any)?.walletAddress) {
      await WebhookSubscription.deleteOne({ walletAddress: String((req.body as any).walletAddress).toLowerCase() });
      return res.status(200).json({ message: "Webhook removed." });
    }

    const owner = validateSignedOwner(req, (req.body as any)?.walletAddress);
    if (!owner) return res.status(401).json({ error: "Unauthorized: signed ownership proof required." });
    await WebhookSubscription.deleteOne({ walletAddress: owner });
    return res.status(200).json({ message: "Webhook removed." });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
};

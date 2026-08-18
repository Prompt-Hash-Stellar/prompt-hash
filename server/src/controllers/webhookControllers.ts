import { Request, Response } from "express";
import { randomBytes } from "crypto";
import connectDb from "../db/connectDb";
import WebhookSubscription from "../models/WebhookSubscription";
import { ALLOWED_EVENTS } from "../services/webhookDispatcher";
import { verifyChallengeSignature } from "../../src/lib/auth/challenge";

const ADMIN_TOKEN = process.env.ADMIN_ROTATION_TOKEN || "";

function isAdminRequest(req: Request) {
  const auth = String(req.headers['authorization'] || req.headers['Authorization'] || "");
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  return token && ADMIN_TOKEN && token === ADMIN_TOKEN;
}

function validateSignedOwner(req: Request, address?: string): string | null {
  const addr = String(address ?? (req.body as any)?.walletAddress ?? (req.query as any)?.walletAddress ?? "").toLowerCase();
  const signedMessage = (req.body as any)?.signedMessage ?? (req.query as any)?.signedMessage;
  const timestamp = (req.body as any)?.timestamp ?? (req.query as any)?.timestamp;
  if (!addr || !signedMessage || !timestamp) return null;
  const expected = `prompt-hash webhooks:${addr}:${timestamp}`;
  try {
    if (verifyChallengeSignature(addr, expected, String(signedMessage))) return addr;
  } catch {
    return null;
  }
  return null;
}

import { validateWebhookUrl } from "../services/ssrfProtection";

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

    // Determine owner: admin may provide walletAddress, otherwise validate signed owner
    let owner: string | null = null;
    if (isAdminRequest(req) && (req.body as any)?.walletAddress) {
      owner = String((req.body as any).walletAddress).toLowerCase();
    } else {
      owner = validateSignedOwner(req, (req.body as any)?.walletAddress);
    }

    if (!owner) return res.status(401).json({ error: "Unauthorized: signed ownership proof required." });

    const secret = randomBytes(32).toString("hex");
    const resolvedEvents = Array.isArray(events) ? events.filter((e: string) => ALLOWED_EVENTS.includes(e as any)) : ["PromptPurchased"];

    const existing = await WebhookSubscription.findOne({ walletAddress: owner });

    if (existing) {
      existing.url = url;
      existing.events = resolvedEvents;
      existing.active = true;
      existing.failureCount = 0;
      await existing.save();
      return res.status(200).json({ message: "Webhook updated.", id: existing._id, secret });
    }

    const sub = new WebhookSubscription({ walletAddress: owner, url, secret, events: resolvedEvents });
    await sub.save();

    return res.status(201).json({ message: "Webhook registered.", id: sub._id, secret });
  } catch (err) {
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

    const { walletAddress } = req.query;
    const owner = validateSignedOwner(req, walletAddress as string | undefined);
    if (!owner) return res.status(401).json({ error: "Unauthorized: signed ownership proof required." });
    const sub = await WebhookSubscription.findOne({ walletAddress: owner }).select("-secret");
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

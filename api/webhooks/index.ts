import { withObservability } from "../../src/lib/observability/wrapper";
import connectDb from "../../server/src/db/connectDb";
import WebhookSubscription from "../../server/src/models/WebhookSubscription";
import { ALLOWED_EVENTS } from "../../server/src/services/webhookDispatcher";
import { randomBytes } from "crypto";
import { verifyChallengeSignature } from "../../src/lib/auth/challenge";

const ADMIN_TOKEN = process.env.ADMIN_ROTATION_TOKEN || "";

function isAdminRequest(req: any) {
  const auth = String(req.headers?.authorization || req.headers?.Authorization || "");
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  return token && ADMIN_TOKEN && token === ADMIN_TOKEN;
}

function validateSignedOwner(req: any, address?: string) {
  const addr = String(address ?? req.body?.walletAddress ?? req.query?.walletAddress ?? "").toLowerCase();
  const signedMessage = req.body?.signedMessage ?? req.query?.signedMessage;
  const timestamp = req.body?.timestamp ?? req.query?.timestamp;
  if (!addr || !signedMessage || !timestamp) return null;
  const expected = `prompt-hash webhooks:${addr}:${timestamp}`;
  try {
    if (verifyChallengeSignature(addr, expected, String(signedMessage))) {
      return addr;
    }
  } catch {
    return null;
  }
  return null;
}

import { validateWebhookUrl } from "../../server/src/services/ssrfProtection";

async function handler(req: any, res: any) {
  await connectDb();

  if (req.method === "GET") {
    await connectDb();
    // Admins may query any walletAddress via Authorization Bearer token
    if (isAdminRequest(req)) {
      const { walletAddress } = req.query ?? {};
      if (!walletAddress) {
        res.status(400).json({ error: "walletAddress query param is required." });
        return;
      }
      const sub = await WebhookSubscription.findOne({ walletAddress: String(walletAddress).toLowerCase() }).select("-secret");
      if (!sub) {
        res.status(404).json({ error: "No webhook registered for this wallet." });
        return;
      }
      res.status(200).json(sub);
      return;
    }

    // For creators: require signed ownership proof
    const owner = validateSignedOwner(req, undefined);
    if (!owner) {
      res.status(401).json({ error: "Unauthorized: signed ownership proof required." });
      return;
    }
    const sub = await WebhookSubscription.findOne({ walletAddress: owner }).select("-secret");
    if (!sub) {
      res.status(404).json({ error: "No webhook registered for this wallet." });
      return;
    }
    res.status(200).json(sub);
    return;
  }

  if (req.method === "POST") {
    await connectDb();
    const { url, events } = req.body ?? {};
    if (!url) {
      res.status(400).json({ error: "url is required." });
      return;
    }
    const ssrfCheck = await validateWebhookUrl(url);
    if (!ssrfCheck.valid) {
      res.status(400).json({ error: "Invalid or blocked webhook destination URL." });
      return;
    }

    // Determine owner: admin may supply walletAddress, creators must authenticate
    let owner: string | null = null;
    if (isAdminRequest(req) && req.body?.walletAddress) {
      owner = String(req.body.walletAddress).toLowerCase();
    } else {
      owner = validateSignedOwner(req, req.body?.walletAddress);
    }

    if (!owner) {
      res.status(401).json({ error: "Unauthorized: signed ownership proof required." });
      return;
    }

    const secret = randomBytes(32).toString("hex");
    const resolvedEvents = Array.isArray(events) ? events.filter((e: string) => ALLOWED_EVENTS.includes(e as any)) : ["PromptPurchased"];

    const existing = await WebhookSubscription.findOne({ walletAddress: owner });

    if (existing) {
      existing.url = url;
      existing.events = resolvedEvents;
      existing.active = true;
      existing.failureCount = 0;
      await existing.save();
      res.status(200).json({ message: "Webhook updated.", id: existing._id, secret });
      return;
    }

    const sub = new WebhookSubscription({ walletAddress: owner, url, secret, events: resolvedEvents });
    await sub.save();
    res.status(201).json({ message: "Webhook registered.", id: sub._id, secret });
    return;
  }

  if (req.method === "DELETE") {
    await connectDb();
    // Admin may delete any subscription when authorized
    if (isAdminRequest(req) && req.body?.walletAddress) {
      await WebhookSubscription.deleteOne({ walletAddress: String(req.body.walletAddress).toLowerCase() });
      res.status(200).json({ message: "Webhook removed." });
      return;
    }

    const owner = validateSignedOwner(req, req.body?.walletAddress);
    if (!owner) {
      res.status(401).json({ error: "Unauthorized: signed ownership proof required." });
      return;
    }
    await WebhookSubscription.deleteOne({ walletAddress: owner });
    res.status(200).json({ message: "Webhook removed." });
    return;
  }

  res.status(405).json({ error: "Method not allowed." });
}

export default withObservability(handler, "webhooks");

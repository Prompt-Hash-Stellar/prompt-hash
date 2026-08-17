import { withObservability } from "../../src/lib/observability/wrapper";
import connectDb from "../../server/src/db/connectDb";
import WebhookSubscription from "../../server/src/models/WebhookSubscription";
import {
  registerOrUpdateWebhook,
  WebhookUpdateConflictError,
} from "../../server/src/services/webhookSubscriptionService";

async function handler(req: any, res: any) {
  await connectDb();

  if (req.method === "GET") {
    const { walletAddress } = req.query ?? {};
    if (!walletAddress) {
      res.status(400).json({ error: "walletAddress query param is required." });
      return;
    }
    const sub = await WebhookSubscription.findOne({
      walletAddress: String(walletAddress).toLowerCase(),
    }).select("-secret -previousSecrets");
    if (!sub) {
      res.status(404).json({ error: "No webhook registered for this wallet." });
      return;
    }
    res.status(200).json(sub);
    return;
  }

  if (req.method === "POST") {
    const { walletAddress, url, events } = req.body ?? {};
    if (!walletAddress || !url) {
      res.status(400).json({ error: "walletAddress and url are required." });
      return;
    }
    try {
      new URL(url);
    } catch {
      res.status(400).json({ error: "url must be a valid URL." });
      return;
    }

    try {
      const result = await registerOrUpdateWebhook({ walletAddress, url, events });
      res.status(result.status).json({
        message: result.message,
        id: result.id,
        secret: result.secret,
        secretRotated: result.secretRotated,
        previousSecretExpiresAt: result.previousSecretExpiresAt,
      });
    } catch (err) {
      if (err instanceof WebhookUpdateConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    return;
  }

  if (req.method === "DELETE") {
    const { walletAddress } = req.body ?? {};
    if (!walletAddress) {
      res.status(400).json({ error: "walletAddress is required." });
      return;
    }
    await WebhookSubscription.deleteOne({ walletAddress: String(walletAddress).toLowerCase() });
    res.status(200).json({ message: "Webhook removed." });
    return;
  }

  res.status(405).json({ error: "Method not allowed." });
}

export default withObservability(handler, "webhooks");

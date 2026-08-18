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

import { createHmac, randomUUID } from "crypto";
import WebhookSubscription from "../models/WebhookSubscription";
import WebhookDeliveryLog from "../models/WebhookDeliveryLog";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000;
const MAX_FAILURES_BEFORE_DISABLE = 10;
const DELIVERY_TIMEOUT_MS = 10_000;

export const ALLOWED_EVENTS = [
  "PromptPurchased",
  "PromptCreated",
  "LicenseTransferred",
  "ReviewSubmitted",
] as const;

export type WebhookEvent = (typeof ALLOWED_EVENTS)[number];

export interface WebhookPayload {
  event: string;
  deliveryId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(
  secret: string,
  body: string,
  signature: string,
): boolean {
  const expected = signPayload(secret, body);
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

function computeRetryDelay(attempt: number): number {
  return BASE_DELAY_MS * Math.pow(2, attempt);
}

async function deliverOnce(
  url: string,
  secret: string,
  payload: WebhookPayload,
): Promise<number> {
  const body = JSON.stringify(payload);
  const signature = signPayload(secret, body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PromptHash-Signature": signature,
      "X-PromptHash-Delivery": payload.deliveryId,
      "X-PromptHash-Event": payload.event,
      "X-PromptHash-Timestamp": payload.timestamp,
    },
    body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });

  return res.status;
}

async function deliverWithRetry(
  subscriptionId: string,
  url: string,
  secret: string,
  payload: WebhookPayload,
): Promise<void> {
  let logEntry = await WebhookDeliveryLog.findOne({ deliveryId: payload.deliveryId });
  if (!logEntry) {
    logEntry = await WebhookDeliveryLog.create({
      deliveryId: payload.deliveryId,
      subscriptionId,
      event: payload.event,
      url,
      status: "retrying",
    });
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    logEntry.attempts = attempt + 1;

    try {
      const status = await deliverOnce(url, secret, payload);
      logEntry.lastStatus = status;

      if (status >= 200 && status < 300) {
        logEntry.status = "success";
        logEntry.completedAt = new Date();
        await logEntry.save();

        await WebhookSubscription.findByIdAndUpdate(subscriptionId, {
          lastDeliveredAt: new Date(),
          $set: { failureCount: 0 },
        });
        return;
      }

      if (status >= 400 && status < 500 && status !== 429) {
        logEntry.status = "failed";
        logEntry.lastError = `HTTP ${status}`;
        logEntry.completedAt = new Date();
        await logEntry.save();

        const updated = await WebhookSubscription.findByIdAndUpdate(
          subscriptionId,
          { $inc: { failureCount: 1 } },
          { new: true },
        );
        if (updated && updated.failureCount >= MAX_FAILURES_BEFORE_DISABLE) {
          await WebhookSubscription.findByIdAndUpdate(subscriptionId, { active: false });
        }
        return;
      }

      logEntry.lastError = `HTTP ${status}`;
    } catch (err) {
      logEntry.lastError = err instanceof Error ? err.message : String(err);
    }

    const isLastAttempt = attempt === MAX_RETRIES;
    if (!isLastAttempt) {
      const delay = computeRetryDelay(attempt);
      logEntry.nextRetryAt = new Date(Date.now() + delay);
      logEntry.status = "retrying";
      await logEntry.save();
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    logEntry.status = "failed";
    logEntry.completedAt = new Date();
    await logEntry.save();

    const updated = await WebhookSubscription.findByIdAndUpdate(
      subscriptionId,
      { $inc: { failureCount: 1 } },
      { new: true },
    );
    if (updated && updated.failureCount >= MAX_FAILURES_BEFORE_DISABLE) {
      await WebhookSubscription.findByIdAndUpdate(subscriptionId, { active: false });
    }
  }
}

export async function dispatchEvent(
  creatorWallet: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!ALLOWED_EVENTS.includes(event as WebhookEvent)) return;

  const subscriptions = await WebhookSubscription.find({
    walletAddress: creatorWallet.toLowerCase(),
    active: true,
    events: event,
  });

  if (subscriptions.length === 0) return;

  const payload: WebhookPayload = {
    event,
    deliveryId: randomUUID(),
    timestamp: new Date().toISOString(),
    data,
  };

  await Promise.allSettled(
    subscriptions.map((sub) =>
      deliverWithRetry(String(sub._id), sub.url, sub.secret, payload),
    ),
  );
}

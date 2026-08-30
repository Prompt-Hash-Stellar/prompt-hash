import { randomBytes } from "crypto";
import WebhookSubscription from "../models/WebhookSubscription";
import { ALLOWED_EVENTS } from "./webhookDispatcher";
import { recordAuditEvent } from "./auditTrail";

/**
 * Bounded overlap window for webhook secret rotation (5 minutes). Matches the
 * challenge-token grace period documented in docs/secret-rotation.md.
 */
export const WEBHOOK_SECRET_OVERLAP_MS = 5 * 60 * 1000;

/** Maximum number of previous secrets retained during the overlap window. */
export const MAX_PREVIOUS_SECRETS = 2;

/** Maximum attempts to rotate when an optimistic-lock conflict is detected. */
const MAX_ROTATION_RETRIES = 3;

export function resolveWebhookEvents(events: unknown): string[] {
  if (!Array.isArray(events)) return ["PromptPurchased"];
  const resolved = events.filter(
    (e): e is string =>
      typeof e === "string" && (ALLOWED_EVENTS as readonly string[]).includes(e),
  );
  return resolved.length > 0 ? resolved : ["PromptPurchased"];
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export interface RegisterOrUpdateWebhookInput {
  walletAddress: string;
  url: string;
  events?: unknown;
}

export interface RegisterOrUpdateWebhookResult {
  status: 200 | 201;
  message: string;
  id: string;
  secret: string;
  secretRotated: boolean;
  previousSecretExpiresAt?: string;
}

export class WebhookUpdateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUpdateConflictError";
  }
}

interface RotationChanges {
  url: string;
  events: string[];
}

/**
 * Register a new webhook subscription or, when one already exists for the
 * wallet, rotate its secret atomically and return the newly persisted value.
 *
 * The returned `secret` always matches the value stored in the database, so a
 * caller that saves it will verify the next delivery. During rotation the old
 * secret is retained for WEBHOOK_SECRET_OVERLAP_MS so deliveries already signed
 * with it (including retries in flight) still verify until the overlap expires.
 */
export async function registerOrUpdateWebhook(
  input: RegisterOrUpdateWebhookInput,
): Promise<RegisterOrUpdateWebhookResult> {
  const walletAddress = input.walletAddress.toLowerCase();
  const url = input.url;
  const events = resolveWebhookEvents(input.events);

  const existing = await WebhookSubscription.findOne({ walletAddress });

  if (!existing) {
    const sub = new WebhookSubscription({
      walletAddress,
      url,
      secret: generateWebhookSecret(),
      events,
    });
    await sub.save();
    return {
      status: 201,
      message: "Webhook registered.",
      id: String(sub._id),
      secret: sub.secret,
      secretRotated: false,
    };
  }

  const rotated = await rotateSecretWithRetry(existing, { url, events });

  return {
    status: 200,
    message: "Webhook updated.",
    id: String(rotated.updated._id),
    secret: rotated.updated.secret,
    secretRotated: true,
    previousSecretExpiresAt: rotated.previousSecretExpiresAt.toISOString(),
  };
}

async function rotateSecretWithRetry(
  existing: any,
  changes: RotationChanges,
): Promise<{ updated: any; previousSecretExpiresAt: Date }> {
  let current = existing;

  for (let attempt = 0; attempt < MAX_ROTATION_RETRIES; attempt++) {
    // On a conflict, re-read the document so we rotate against the latest
    // secretVersion rather than a stale copy.
    if (attempt > 0) {
      current = await WebhookSubscription.findById(existing._id);
      if (!current) {
        throw new WebhookUpdateConflictError(
          "Webhook subscription no longer exists.",
        );
      }
    }

    const newSecret = generateWebhookSecret();
    const previousSecretExpiresAt = new Date(
      Date.now() + WEBHOOK_SECRET_OVERLAP_MS,
    );

    // Optimistic concurrency: only apply the rotation if the version has not
    // changed since we read it. `findOneAndUpdate` is atomic, so the returned
    // document's secret is always the value actually persisted.
    const updated = await WebhookSubscription.findOneAndUpdate(
      {
        _id: current._id,
        secretVersion: current.secretVersion,
      },
      {
        $set: {
          secret: newSecret,
          url: changes.url,
          events: changes.events,
          active: true,
          failureCount: 0,
          secretVersion: (current.secretVersion ?? 0) + 1,
        },
        $push: {
          previousSecrets: {
            $each: [
              { secret: current.secret, expiresAt: previousSecretExpiresAt },
            ],
            $slice: -MAX_PREVIOUS_SECRETS,
          },
        },
      },
      { new: true },
    );

    if (updated) {
      // Audit the rotation without ever logging secret material. The audit
      // record stores only a hash of the wallet address.
      recordAuditEvent({
        action: "webhook_secret_rotated",
        result: "success",
        walletAddress: updated.walletAddress,
      }).catch(() => {});
      return { updated, previousSecretExpiresAt };
    }
  }

  throw new WebhookUpdateConflictError(
    "Webhook update failed due to a concurrent modification. Please retry.",
  );
}

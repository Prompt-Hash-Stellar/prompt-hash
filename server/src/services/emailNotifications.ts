/**
 * emailNotifications.ts — Issue #112 / Refactored for Durable Notifications
 *
 * Email notification service for PromptPurchased and PromptUpdated events.
 * Uses nodemailer with persistent pooled transport, job queuing in MongoDB,
 * idempotent event handling, retry backoff, dead-lettering, telemetry redaction,
 * and bounded worker concurrency.
 */

import nodemailer from "nodemailer";
import User from "../models/User";
import EmailNotificationJob, {
  IEmailNotificationJob,
  JobStatus,
} from "../models/EmailNotificationJob";

// ── Types ──────────────────────────────────────────────────────────────────────

export type NotificationEvent = "PromptPurchased" | "PromptUpdated";

export interface PurchasePayload {
  buyerWallet: string;
  promptTitle: string;
  promptId: string;
  txHash?: string;
}

export interface UpdatePayload {
  ownerWallet: string;
  promptTitle: string;
  promptId: string;
  versionIndex: number;
}

export interface EnqueueJobOptions {
  event: NotificationEvent;
  recipientWallet: string;
  payload: PurchasePayload | UpdatePayload;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export interface ProcessJobsResult {
  processed: number;
  succeeded: number;
  failed: number;
  deadLetter: number;
  skipped: number;
}

// ── Transport Management ──────────────────────────────────────────────────────

let activeTransport: nodemailer.Transporter | null = null;

export function setTransport(customTransport: nodemailer.Transporter | null): void {
  activeTransport = customTransport;
}

export function getPooledTransport(): nodemailer.Transporter {
  if (activeTransport) return activeTransport;

  const socketTimeout = Number(process.env.EMAIL_SMTP_TIMEOUT ?? 5000);
  activeTransport = nodemailer.createTransport({
    host: process.env.EMAIL_SMTP_HOST,
    port: Number(process.env.EMAIL_SMTP_PORT ?? 587),
    secure: process.env.EMAIL_SMTP_PORT === "465",
    pool: true,
    maxConnections: Number(process.env.EMAIL_SMTP_MAX_CONNECTIONS ?? 5),
    socketTimeout,
    connectionTimeout: socketTimeout,
    auth: {
      user: process.env.EMAIL_SMTP_USER,
      pass: process.env.EMAIL_SMTP_PASS,
    },
  });
  return activeTransport;
}

export async function closeTransport(): Promise<void> {
  if (activeTransport) {
    try {
      activeTransport.close();
    } catch {
      // Closing the transport is best-effort; a failure here is safe to ignore.
    }
    activeTransport = null;
  }
}

const FROM = process.env.EMAIL_FROM_ADDRESS ?? "PromptHash <noreply@prompthash.io>";

// ── Telemetry & Redaction ─────────────────────────────────────────────────────

export function redactEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string") return "[REDACTED_EMAIL]";
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "[REDACTED_EMAIL]";

  const localPart = email.slice(0, atIndex);
  const domainPart = email.slice(atIndex + 1);

  const redactedLocal =
    localPart.length <= 2
      ? `${localPart[0] ?? "*"}***`
      : `${localPart[0]}***${localPart[localPart.length - 1]}`;

  const domainDotIndex = domainPart.lastIndexOf(".");
  let redactedDomain = domainPart;
  if (domainDotIndex > 0) {
    const domainName = domainPart.slice(0, domainDotIndex);
    const domainExt = domainPart.slice(domainDotIndex);
    const redDomainName =
      domainName.length <= 2
        ? `${domainName[0] ?? "*"}***`
        : `${domainName[0]}***${domainName[domainName.length - 1]}`;
    redactedDomain = `${redDomainName}${domainExt}`;
  }

  return `${redactedLocal}@${redactedDomain}`;
}

// ── HTML/Text escaping & safe link construction (#168) ─────────────────────────

/**
 * Escapes text for safe interpolation into HTML markup and strips line
 * breaks. Prevents untrusted prompt metadata (titles, wallet fragments,
 * transaction hashes, IDs) from injecting tags, attributes, or scripts
 * into notification emails.
 */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r\n|\r|\n/g, " ");
}

/**
 * Strips CR/LF from values destined for the email subject line to prevent
 * header injection via untrusted prompt metadata.
 */
export function sanitizeForSubject(value: string): string {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

const DEFAULT_APP_ORIGIN = "https://prompthash.io";

/**
 * Validates and returns a single canonical HTTPS application origin.
 * Falls back to the default origin whenever APP_URL is missing, malformed,
 * or not HTTPS, so links can never point at an attacker-controlled or
 * non-HTTPS origin.
 */
export function getAppOrigin(): string {
  const raw = process.env.APP_URL;
  if (!raw) return DEFAULT_APP_ORIGIN;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return DEFAULT_APP_ORIGIN;
    return parsed.origin;
  } catch {
    return DEFAULT_APP_ORIGIN;
  }
}

/**
 * Builds a safe absolute link to a prompt page under the validated
 * application origin, URL-encoding the prompt id path segment.
 */
export function buildPromptUrl(promptId: string): string {
  return `${getAppOrigin()}/prompts/${encodeURIComponent(promptId)}`;
}

// ── Template builders ─────────────────────────────────────────────────────────

function buildPurchaseEmail(payload: PurchasePayload): { subject: string; html: string; text: string } {
  const title = escapeHtml(payload.promptTitle);
  const subjectTitle = sanitizeForSubject(payload.promptTitle);
  const walletFragment = escapeHtml(payload.buyerWallet.slice(0, 8));
  const promptUrl = buildPromptUrl(payload.promptId);
  const txHashHtml = payload.txHash
    ? `<p>Transaction: <code>${escapeHtml(payload.txHash)}</code></p>`
    : "";
  const txHashText = payload.txHash ? `Transaction: ${payload.txHash}\n` : "";

  return {
    subject: `🎉 Your prompt "${subjectTitle}" was purchased`,
    html: `
      <h2>Congratulations!</h2>
      <p>A buyer (<code>${walletFragment}…</code>) just purchased
         your prompt <strong>${title}</strong>.</p>
      ${txHashHtml}
      <p><a href="${promptUrl}">
        View prompt
      </a></p>
      <hr/>
      <small>To manage your notification preferences visit your account settings.</small>
    `,
    text: `Congratulations!\n\nA buyer (${payload.buyerWallet.slice(0, 8)}…) just purchased your prompt "${payload.promptTitle}".\n${txHashText}View prompt: ${promptUrl}\n\nTo manage your notification preferences visit your account settings.`,
  };
}

function buildUpdateEmail(payload: UpdatePayload): { subject: string; html: string; text: string } {
  const title = escapeHtml(payload.promptTitle);
  const subjectTitle = sanitizeForSubject(payload.promptTitle);
  const promptUrl = buildPromptUrl(payload.promptId);

  return {
    subject: `📦 Prompt updated: "${subjectTitle}" (v${payload.versionIndex + 1})`,
    html: `
      <h2>Prompt Updated</h2>
      <p>The prompt <strong>${title}</strong> you purchased has been updated
         to version ${payload.versionIndex + 1}.</p>
      <p><a href="${promptUrl}">
        View updated prompt
      </a></p>
      <hr/>
      <small>To manage your notification preferences visit your account settings.</small>
    `,
    text: `Prompt Updated\n\nThe prompt "${payload.promptTitle}" you purchased has been updated to version ${payload.versionIndex + 1}.\nView updated prompt: ${promptUrl}\n\nTo manage your notification preferences visit your account settings.`,
  };
}

// ── Core send helper ──────────────────────────────────────────────────────────

async function sendEmailWithTransport(
  to: string,
  subject: string,
  html: string,
  text: string,
  timeoutMs: number = 5000
): Promise<void> {
  const transport = getPooledTransport();

  let timeoutTimer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      reject(new Error(`SMTP send mail timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      transport.sendMail({ from: FROM, to, subject, html, text }),
      timeoutPromise,
    ]);
    console.log(`[email] Sent "${subject}" to ${redactEmail(to)}`);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

// ── User preference helpers ───────────────────────────────────────────────────

export async function getEmailForWallet(wallet: string): Promise<string | null> {
  if (!wallet) return null;
  const user = await User.findOne({ walletAddress: wallet.toLowerCase() }).lean();
  return (user as { email?: string } | null)?.email ?? null;
}

export async function hasOptedIn(wallet: string, event: NotificationEvent): Promise<boolean> {
  if (!wallet) return false;
  const user = await User.findOne({ walletAddress: wallet.toLowerCase() }).lean();
  if (!user) return false;
  const prefs = (user as { notificationPreferences?: Partial<Record<NotificationEvent, boolean>> })
    .notificationPreferences;
  // Default opt-in when prefs not explicitly set
  return prefs?.[event] !== false;
}

// ── Job Enqueuing & Idempotency ───────────────────────────────────────────────

export async function enqueueNotificationJob(
  options: EnqueueJobOptions
): Promise<IEmailNotificationJob> {
  const wallet = options.recipientWallet.toLowerCase();

  let key = options.idempotencyKey;
  if (!key) {
    if (options.event === "PromptPurchased") {
      const p = options.payload as PurchasePayload;
      key = `PromptPurchased:${wallet}:${p.promptId}:${p.txHash ?? p.buyerWallet}`;
    } else {
      const p = options.payload as UpdatePayload;
      key = `PromptUpdated:${wallet}:${p.promptId}:v${p.versionIndex}`;
    }
  }

  // Idempotency check: if job already exists, return it immediately
  const existingJob = await EmailNotificationJob.findOne({ idempotencyKey: key });
  if (existingJob) {
    console.log(`[email] Idempotent hit: job ${key} already exists (status: ${existingJob.status})`);
    return existingJob;
  }

  // Preference snapshot
  const optedIn = await hasOptedIn(wallet, options.event);
  const email = await getEmailForWallet(wallet);

  let initialStatus: JobStatus = "pending";
  let lastError: string | null = null;

  if (!optedIn) {
    initialStatus = "skipped";
    lastError = "User opted out in preference snapshot";
  } else if (!email) {
    initialStatus = "skipped";
    lastError = "No registered email address for user";
  }

  try {
    const job = await EmailNotificationJob.create({
      idempotencyKey: key,
      event: options.event,
      recipientWallet: wallet,
      recipientEmail: email,
      preferenceSnapshot: { optedIn },
      payload: options.payload,
      status: initialStatus,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      lastError,
      nextRetryAt: initialStatus === "pending" ? new Date() : null,
    });
    console.log(
      `[email] Enqueued job ${key} for ${redactEmail(email)} (status: ${initialStatus}, optedIn: ${optedIn})`
    );
    return job;
  } catch (err: any) {
    if (err.code === 11000 || err.message?.includes("E11000")) {
      const job = await EmailNotificationJob.findOne({ idempotencyKey: key });
      if (job) return job;
    }
    throw err;
  }
}

// ── Bounded Worker Processing ─────────────────────────────────────────────────

export async function processPendingJobs(options?: {
  concurrency?: number;
  maxBatch?: number;
  timeoutMs?: number;
}): Promise<ProcessJobsResult> {
  const concurrency = options?.concurrency ?? 5;
  const maxBatch = options?.maxBatch ?? 50;
  const timeoutMs = options?.timeoutMs ?? 5000;

  const now = new Date();
  const staleThreshold = new Date(now.getTime() - 5 * 60 * 1000);

  const candidateJobs = await EmailNotificationJob.find({
    $or: [
      { status: "pending", $or: [{ nextRetryAt: { $lte: now } }, { nextRetryAt: null }] },
      { status: "processing", updatedAt: { $lte: staleThreshold } },
    ],
  })
    .limit(maxBatch)
    .exec();

  const stats: ProcessJobsResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    deadLetter: 0,
    skipped: 0,
  };

  if (candidateJobs.length === 0) {
    return stats;
  }

  for (let i = 0; i < candidateJobs.length; i += concurrency) {
    const workerBatch = candidateJobs.slice(i, i + concurrency);

    await Promise.all(
      workerBatch.map(async (job) => {
        const claimedJob = await EmailNotificationJob.findOneAndUpdate(
          {
            _id: job._id,
            status: { $in: ["pending", "processing"] },
          },
          {
            status: "processing",
            $inc: { attempts: 1 },
          },
          { new: true }
        );

        if (!claimedJob) return;

        stats.processed++;

        if (!claimedJob.preferenceSnapshot?.optedIn) {
          claimedJob.status = "skipped";
          claimedJob.completedAt = new Date();
          claimedJob.lastError = "User opted out in preference snapshot";
          await claimedJob.save();
          stats.skipped++;
          return;
        }

        let email = claimedJob.recipientEmail;
        if (!email) {
          email = await getEmailForWallet(claimedJob.recipientWallet);
          if (email) {
            claimedJob.recipientEmail = email;
          } else {
            claimedJob.status = "skipped";
            claimedJob.completedAt = new Date();
            claimedJob.lastError = "No registered email address for user";
            await claimedJob.save();
            stats.skipped++;
            return;
          }
        }

        let subject: string;
        let html: string;
        let text: string;
        if (claimedJob.event === "PromptPurchased") {
          const content = buildPurchaseEmail(claimedJob.payload as PurchasePayload);
          subject = content.subject;
          html = content.html;
          text = content.text;
        } else {
          const content = buildUpdateEmail(claimedJob.payload as UpdatePayload);
          subject = content.subject;
          html = content.html;
          text = content.text;
        }

        try {
          if (!process.env.EMAIL_SMTP_HOST && !activeTransport) {
            console.warn("[email] SMTP not configured — skipping email to", redactEmail(email));
            claimedJob.status = "skipped";
            claimedJob.lastError = "SMTP host not configured";
            claimedJob.completedAt = new Date();
            await claimedJob.save();
            stats.skipped++;
            return;
          }

          await sendEmailWithTransport(email, subject, html, text, timeoutMs);

          claimedJob.status = "completed";
          claimedJob.completedAt = new Date();
          claimedJob.lastError = null;
          await claimedJob.save();
          stats.succeeded++;
        } catch (err: any) {
          const errorMessage = err?.message || String(err);
          console.error(
            `[email] Delivery failed for job ${claimedJob.idempotencyKey} (attempt ${claimedJob.attempts}): ${errorMessage}`
          );

          const isPermanent =
            errorMessage.includes("550") ||
            errorMessage.includes("Invalid recipient") ||
            errorMessage.includes("No recipients defined");

          if (isPermanent || claimedJob.attempts >= claimedJob.maxAttempts) {
            claimedJob.status = "dead-letter";
            claimedJob.failedAt = new Date();
            claimedJob.lastError = errorMessage;
            await claimedJob.save();
            stats.deadLetter++;
          } else {
            const backoffMs = Math.min(100 * Math.pow(2, claimedJob.attempts - 1), 60000);
            claimedJob.status = "pending";
            claimedJob.nextRetryAt = new Date(Date.now() + backoffMs);
            claimedJob.lastError = errorMessage;
            await claimedJob.save();
            stats.failed++;
          }
        }
      })
    );
  }

  return stats;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function notifyPromptPurchased(
  creatorWallet: string,
  payload: PurchasePayload,
  options?: { idempotencyKey?: string; processSync?: boolean }
): Promise<IEmailNotificationJob | null> {
  try {
    const job = await enqueueNotificationJob({
      event: "PromptPurchased",
      recipientWallet: creatorWallet,
      payload,
      idempotencyKey: options?.idempotencyKey,
    });

    if (options?.processSync !== false) {
      await processPendingJobs();
    }

    return job;
  } catch (err) {
    console.error(
      `[email] notifyPromptPurchased failed to enqueue for creator ${creatorWallet.slice(0, 8)}…`,
      err
    );
    return null;
  }
}

export async function notifyPromptUpdated(
  buyerWallets: string[],
  payload: UpdatePayload,
  options?: { idempotencyKeyPrefix?: string; batchSize?: number; processSync?: boolean }
): Promise<IEmailNotificationJob[]> {
  const jobs: IEmailNotificationJob[] = [];
  const batchSize = options?.batchSize ?? 50;

  for (let i = 0; i < buyerWallets.length; i += batchSize) {
    const chunk = buyerWallets.slice(i, i + batchSize);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (wallet) => {
        const key = options?.idempotencyKeyPrefix
          ? `${options.idempotencyKeyPrefix}:${wallet.toLowerCase()}`
          : undefined;
        return enqueueNotificationJob({
          event: "PromptUpdated",
          recipientWallet: wallet,
          payload,
          idempotencyKey: key,
        });
      })
    );

    for (const res of chunkResults) {
      if (res.status === "fulfilled") {
        jobs.push(res.value);
      } else {
        console.error("[email] Failed to enqueue buyer update job:", res.reason);
      }
    }
  }

  if (options?.processSync !== false) {
    await processPendingJobs();
  }

  return jobs;
}

// ── Helper Queries & Worker Controls ──────────────────────────────────────────

export async function getNotificationJobStatus(
  idempotencyKey: string
): Promise<IEmailNotificationJob | null> {
  return EmailNotificationJob.findOne({ idempotencyKey }).exec();
}

export async function getBatchNotificationStatus(idempotencyKeys: string[]): Promise<{
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  deadLetter: number;
  skipped: number;
}> {
  const jobs = await EmailNotificationJob.find({ idempotencyKey: { $in: idempotencyKeys } }).exec();
  const counts = {
    total: idempotencyKeys.length,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    deadLetter: 0,
    skipped: 0,
  };

  for (const job of jobs) {
    if (job.status === "pending") counts.pending++;
    else if (job.status === "processing") counts.processing++;
    else if (job.status === "completed") counts.completed++;
    else if (job.status === "failed") counts.failed++;
    else if (job.status === "dead-letter") counts.deadLetter++;
    else if (job.status === "skipped") counts.skipped++;
  }

  return counts;
}

export function startEmailWorker(intervalMs = 5000): NodeJS.Timeout {
  return setInterval(() => {
    processPendingJobs().catch((err) => {
      console.error("[email] Error in background worker loop:", err);
    });
  }, intervalMs);
}

export function stopEmailWorker(timer: NodeJS.Timeout): void {
  clearInterval(timer);
}

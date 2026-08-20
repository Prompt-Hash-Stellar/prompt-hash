import crypto from "crypto";
import mongoose from "mongoose";
import Prompt from "../models/Prompt";
import { PreviewClaim, PreviewEvent, PreviewRateBucket } from "../models/PreviewEvent";

const DEDUPE_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 20;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 5 * 60 * 1000;

const secret = () => {
  const value = process.env.PREVIEW_EVENT_SECRET || process.env.JWT_SECRET;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("PREVIEW_EVENT_SECRET is required in production");
  }
  return value || "local-preview-event-secret";
};

const encode = (value: string) => Buffer.from(value).toString("base64url");
const sign = (payload: string) => crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

export function issuePreviewToken(promptId: string, now = Date.now()): string {
  const payload = encode(JSON.stringify({ promptId, exp: now + TOKEN_TTL_MS, nonce: crypto.randomUUID() }));
  return `${payload}.${sign(payload)}`;
}

export function verifyPreviewToken(token: string, promptId: string, now = Date.now()): boolean {
  try {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return false;
    const expected = sign(payload);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
    return parsed.promptId === promptId && Number(parsed.exp) >= now;
  } catch {
    return false;
  }
}

export function visitorHash(sessionId: string, ip: string, userAgent: string): string {
  return crypto.createHmac("sha256", secret()).update(`${sessionId}|${ip}|${userAgent}`).digest("hex");
}

function rateLimitHash(ip: string): string {
  return crypto.createHmac("sha256", secret()).update(`rate|${ip}`).digest("hex");
}

export function looksAutomated(userAgent: string): boolean {
  return !userAgent || /bot|crawler|spider|headless|curl|wget|python-requests|postman/i.test(userAgent);
}

const floorWindow = (now: number, size: number) => new Date(Math.floor(now / size) * size);
const expiry = (now: number) => new Date(now + EVENT_RETENTION_MS);

async function logEvent(data: Record<string, unknown>) {
  await PreviewEvent.create({ ...data, expiresAt: expiry(Date.now()) });
}

export async function recordPreviewEvent(input: {
  promptId: string; sessionId: string; token: string; ip: string; userAgent: string; now?: number;
}) {
  const now = input.now ?? Date.now();
  const hash = visitorHash(input.sessionId, input.ip, input.userAgent);
  const windowStart = floorWindow(now, DEDUPE_MS);
  const base = { promptId: mongoose.isValidObjectId(input.promptId) ? input.promptId : undefined, visitorHash: hash, windowStart };

  if (!verifyPreviewToken(input.token, input.promptId, now)) {
    await logEvent({ ...base, outcome: "invalid_token", reason: "token_missing_invalid_or_expired" });
    return { status: 400, counted: false, reason: "invalid_token" };
  }
  if (looksAutomated(input.userAgent)) {
    await logEvent({ ...base, outcome: "bot_filtered", reason: "automated_user_agent" });
    return { status: 202, counted: false, reason: "bot_filtered" };
  }

  const prompt = await Prompt.findOne({ _id: input.promptId, isActive: true, listingStatus: "published" }).select("_id");
  if (!prompt) {
    await logEvent({ ...base, outcome: "invalid_prompt", reason: "invalid_inactive_or_unpublished_prompt" });
    return { status: 404, counted: false, reason: "invalid_or_inactive_prompt" };
  }

  const rateWindow = floorWindow(now, RATE_WINDOW_MS);
  let bucket: any;
  try {
    bucket = await PreviewRateBucket.findOneAndUpdate(
      { visitorHash: rateLimitHash(input.ip), windowStart: rateWindow },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(now + RATE_WINDOW_MS * 2) } },
      { upsert: true, new: true },
    );
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    bucket = await PreviewRateBucket.findOneAndUpdate(
      { visitorHash: rateLimitHash(input.ip), windowStart: rateWindow }, { $inc: { count: 1 } }, { new: true },
    );
  }
  if (bucket.count > RATE_LIMIT) {
    await logEvent({ ...base, outcome: "rate_limited", reason: "visitor_burst_limit" });
    return { status: 429, counted: false, reason: "rate_limited" };
  }

  try {
    await PreviewClaim.create({ ...base, expiresAt: new Date(now + DEDUPE_MS * 2) });
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    await logEvent({ ...base, outcome: "deduped", reason: "visitor_prompt_window_replay" });
    return { status: 200, counted: false, reason: "deduped" };
  }

  await Prompt.updateOne({ _id: prompt._id }, { $inc: { previewCount: 1 } });
  await logEvent({ ...base, outcome: "counted", reason: "unique_verified_preview" });
  return { status: 200, counted: true, reason: "counted" };
}

import { randomUUID } from "crypto";
import connectDb from "../db/connectDb";
import Report from "../models/Report";
import { recordAuditEvent } from "./auditTrail";
import {
  authorizeReportReview,
  ReportAuthError,
  type ReportReviewPrincipal,
} from "../auth/reportAuth";

/**
 * Abuse-report listing access policy — Issue #146.
 *
 * Authorization is performed BEFORE any report data is queried, so an
 * unauthorized caller can never observe whether reports exist. The raw Report
 * model is never returned; only the allowlisted fields below are exposed.
 *
 * The reporter's wallet address (`reporterAddress`) is sensitive and is NOT
 * returned by the listing endpoint. Internal database fields (`_id`, `__v`)
 * are likewise excluded.
 */
export interface ReportDto {
  id: string;
  promptId: string;
  reason: string;
  description: string;
  status: string;
  adminNotes: string;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Explicit allowlist projection — no other fields may leave the server. */
export function toReportDto(report: {
  _id?: unknown;
  promptId?: unknown;
  reason?: unknown;
  description?: unknown;
  status?: unknown;
  adminNotes?: unknown;
  resolvedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}): ReportDto {
  return {
    id: report._id ? String(report._id) : "",
    promptId: report.promptId ? String(report.promptId) : "",
    reason: report.reason ? String(report.reason) : "",
    description: report.description ? String(report.description) : "",
    status: report.status ? String(report.status) : "",
    adminNotes: report.adminNotes ? String(report.adminNotes) : "",
    resolvedAt: (report.resolvedAt as Date | null) ?? null,
    createdAt: report.createdAt as Date,
    updatedAt: report.updatedAt as Date,
  };
}

export interface ListReportsOptions {
  authorizationHeader?: string;
  promptId?: string | null;
  requestId?: string;
  /** Clock override used for deterministic expiry checks in tests. */
  now?: number;
}

export interface ListReportsResult {
  status: number;
  body: unknown;
}

export async function listPromptReports(
  options: ListReportsOptions,
): Promise<ListReportsResult> {
  const requestId = options.requestId ?? randomUUID();

  // 1. Authorize first — never query or expose report data before this passes.
  let principal: ReportReviewPrincipal;
  try {
    principal = authorizeReportReview(options.authorizationHeader, options.now);
  } catch (err) {
    const code =
      err instanceof ReportAuthError ? err.code : "invalid_token";
    const status = code === "forbidden" ? 403 : 401;

    // Audit the denial with safe metadata only — never the token or header.
    void recordAuditEvent({
      action: "report_review_denied",
      result: "failure",
      promptId: null,
      walletAddress: null,
      requestId,
      clientIp: null,
      reason: code,
    });

    return {
      status,
      body: { error: status === 403 ? "Forbidden" : "Unauthorized" },
    };
  }

  try {
    await connectDb();

    const query: Record<string, unknown> = {};
    if (options.promptId) {
      query.promptId = options.promptId;
    }

    const reports = await Report.find(query)
      .sort({ createdAt: -1 })
      .lean();

    // Audit successful access with safe metadata only.
    void recordAuditEvent({
      action: "report_review_access",
      result: "success",
      promptId: options.promptId ?? null,
      walletAddress: principal.sub,
      requestId,
      clientIp: null,
      reason: null,
    });

    return {
      status: 200,
      body: reports.map(toReportDto),
    };
  } catch (err) {
    console.error("Get reports error:", err);
    return { status: 500, body: { error: "Failed to fetch reports" } };
  }
}

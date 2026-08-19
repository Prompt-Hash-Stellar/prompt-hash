/**
 * Security regression tests for abuse-report listing authorization (Issue #146).
 *
 * The old implementation treated the presence of a non-empty bearer token as
 * authentication. These tests prove that:
 *   - arbitrary/empty/malformed tokens are rejected,
 *   - expired and revoked credentials are rejected,
 *   - wrong-role principals are rejected,
 *   - only a verified report_reviewer/admin can list reports,
 *   - the raw report model is never returned (allowlisted DTO only),
 *   - filtering still works, and
 *   - audit logging uses safe metadata and never records credentials.
 */

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────
const mockConnectDb = jest.fn();
const mockReportFind = jest.fn();
const mockReportSort = jest.fn();
const mockReportLean = jest.fn();
const mockRecordAuditEvent = jest.fn();

jest.mock("../db/connectDb", () => ({
  __esModule: true,
  default: mockConnectDb,
}));

jest.mock("../models/Report", () => ({
  __esModule: true,
  default: { find: mockReportFind },
}));

jest.mock("../services/auditTrail", () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

import { createHmac } from "crypto";
import {
  authorizeReportReview,
  signReportReviewToken,
  verifyReportReviewToken,
  revokeReportReviewToken,
  clearReportReviewRevocations,
  ReportAuthError,
  REPORT_REVIEWER_ROLE,
  ADMIN_ROLE,
  type ReportReviewRole,
} from "../auth/reportAuth";
import { listPromptReports, toReportDto } from "../services/reportService";

const TEST_SECRET = "test-report-review-secret-0000000000000000"; // >= 32 chars
const BASE_NOW = 1_700_000_000_000;

function signToken(opts: {
  sub?: string;
  role?: string;
  secret?: string;
  jti?: string;
  now?: number;
  ttlMs?: number;
}): string {
  return signReportReviewToken({
    sub: opts.sub ?? "GBREVIEWER",
    role: (opts.role ?? REPORT_REVIEWER_ROLE) as ReportReviewRole,
    secret: opts.secret ?? TEST_SECRET,
    jti: opts.jti,
    now: opts.now ?? BASE_NOW,
    ttlMs: opts.ttlMs,
  });
}

function forgeToken(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", TEST_SECRET).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.REPORT_REVIEW_SECRET = TEST_SECRET;
  delete process.env.REPORT_REVIEW_REVOKED_JTIS;
  clearReportReviewRevocations();

  mockReportFind.mockReturnValue({ sort: mockReportSort });
  mockReportSort.mockReturnValue({ lean: mockReportLean });
  mockReportLean.mockResolvedValue([]);
});

afterAll(() => {
  delete process.env.REPORT_REVIEW_SECRET;
});

// ── Token issuance / verification ───────────────────────────────────────────

describe("reportAuth token verification", () => {
  it("verifies a valid report_reviewer credential and returns its claims", () => {
    const token = signToken({ sub: "GREVIEWER1", role: REPORT_REVIEWER_ROLE });
    const claims = verifyReportReviewToken(token, BASE_NOW + 1000);

    expect(claims.sub).toBe("GREVIEWER1");
    expect(claims.role).toBe(REPORT_REVIEWER_ROLE);
    expect(claims.aud).toBe("prompt-hash-reports");
  });

  it("verifies a valid admin credential", () => {
    const token = signToken({ sub: "GADMIN1", role: ADMIN_ROLE });
    const principal = authorizeReportReview(`Bearer ${token}`, BASE_NOW + 1000);

    expect(principal).toEqual({ sub: "GADMIN1", role: ADMIN_ROLE });
  });

  it("rejects a random non-empty bearer token (the original bypass)", () => {
    try {
      authorizeReportReview("Bearer totally.random-token", BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("invalid_token");
    }
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = signToken({ secret: "another-secret-0000000000000000000000" });
    try {
      verifyReportReviewToken(token, BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("invalid_token");
    }
  });

  it("rejects a tampered token (signature mismatch)", () => {
    const token = signToken({});
    const [encoded] = token.split(".");
    const tampered = `${encoded}.${"0".repeat(43)}`;
    try {
      verifyReportReviewToken(tampered, BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("invalid_token");
    }
  });

  it("rejects an expired credential", () => {
    const token = signToken({ ttlMs: 1000 });
    try {
      verifyReportReviewToken(token, BASE_NOW + 2000);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("expired_token");
    }
  });

  it("rejects a revoked credential even when structurally valid", () => {
    const token = signToken({ jti: "revoke-me-1" });
    revokeReportReviewToken("revoke-me-1");
    try {
      verifyReportReviewToken(token, BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("revoked_token");
    }
  });

  it("rejects a future-issued credential (clock skew)", () => {
    const token = signToken({ now: BASE_NOW + 10 * 60 * 1000 });
    try {
      verifyReportReviewToken(token, BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("invalid_token");
    }
  });
});

// ── Authorization header handling ───────────────────────────────────────────

describe("reportAuth header handling", () => {
  it("rejects a missing Authorization header", () => {
    try {
      authorizeReportReview(undefined, BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("missing_credentials");
    }
  });

  it("rejects a malformed Authorization header (no Bearer scheme)", () => {
    try {
      authorizeReportReview("Basic abc123", BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("malformed_credentials");
    }
  });

  it("rejects an empty bearer token", () => {
    try {
      authorizeReportReview("Bearer ", BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("malformed_credentials");
    }
  });

  it("rejects an empty Authorization header", () => {
    try {
      authorizeReportReview("", BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("malformed_credentials");
    }
  });

  it("rejects a header with extra segments", () => {
    try {
      authorizeReportReview("Bearer token extra", BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("malformed_credentials");
    }
  });
});

// ── Role authorization ──────────────────────────────────────────────────────

describe("reportAuth role enforcement", () => {
  it("rejects a verified credential with an unknown role", () => {
    const token = signToken({ role: "viewer" });
    try {
      authorizeReportReview(`Bearer ${token}`, BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("forbidden");
    }
  });

  it("rejects a credential missing a role claim", () => {
    const forged = forgeToken({
      sub: "GX",
      jti: "j1",
      iat: BASE_NOW,
      exp: BASE_NOW + 1000,
      aud: "prompt-hash-reports",
    });

    try {
      verifyReportReviewToken(forged, BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("invalid_token");
    }
  });

  it("rejects a credential with a malformed (non-string) role", () => {
    const forged = forgeToken({
      sub: "GX",
      role: 123,
      jti: "j2",
      iat: BASE_NOW,
      exp: BASE_NOW + 1000,
      aud: "prompt-hash-reports",
    });

    try {
      verifyReportReviewToken(forged, BASE_NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReportAuthError).code).toBe("invalid_token");
    }
  });
});

// ── DTO projection ──────────────────────────────────────────────────────────

describe("toReportDto (allowlisted projection)", () => {
  const rawReport = {
    _id: "6650f1abc",
    promptId: "p1",
    reporterAddress: "GREPORTER_SECRET_IDENTITY",
    reason: "plagiarism",
    description: "copied content",
    status: "pending",
    adminNotes: "looking into it",
    resolvedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    __v: 0,
    internalToken: "should-never-leak",
  };

  it("includes only allowlisted fields", () => {
    const dto = toReportDto(rawReport);
    expect(dto).toEqual({
      id: "6650f1abc",
      promptId: "p1",
      reason: "plagiarism",
      description: "copied content",
      status: "pending",
      adminNotes: "looking into it",
      resolvedAt: null,
      createdAt: rawReport.createdAt,
      updatedAt: rawReport.updatedAt,
    });
  });

  it("never exposes reporter identity or internal fields", () => {
    const dto = toReportDto(rawReport);
    expect(dto).not.toHaveProperty("reporterAddress");
    expect(dto).not.toHaveProperty("_id");
    expect(dto).not.toHaveProperty("__v");
    expect(dto).not.toHaveProperty("internalToken");
  });
});

// ── listPromptReports (controller-level behavior) ───────────────────────────

describe("listPromptReports", () => {
  const sampleReports = [
    {
      _id: "r1",
      promptId: "p1",
      reporterAddress: "greporter",
      reason: "plagiarism",
      description: "desc",
      status: "pending",
      adminNotes: "",
      resolvedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      __v: 0,
    },
  ];

  it("rejects a random non-empty bearer token and does not query reports", async () => {
    const result = await listPromptReports({
      authorizationHeader: "Bearer random-token",
      promptId: "p1",
      requestId: "req-1",
      now: BASE_NOW,
    });

    expect(result.status).toBe(401);
    expect(mockReportFind).not.toHaveBeenCalled();
    expect(result.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects a missing Authorization header", async () => {
    const result = await listPromptReports({
      authorizationHeader: undefined,
      promptId: "p1",
      requestId: "req-2",
      now: BASE_NOW,
    });

    expect(result.status).toBe(401);
    expect(mockReportFind).not.toHaveBeenCalled();
  });

  it("rejects a malformed Authorization header", async () => {
    const result = await listPromptReports({
      authorizationHeader: "Token abc",
      requestId: "req-3",
      now: BASE_NOW,
    });

    expect(result.status).toBe(401);
    expect(mockReportFind).not.toHaveBeenCalled();
  });

  it("rejects an empty bearer token", async () => {
    const result = await listPromptReports({
      authorizationHeader: "Bearer ",
      requestId: "req-4",
      now: BASE_NOW,
    });

    expect(result.status).toBe(401);
    expect(mockReportFind).not.toHaveBeenCalled();
  });

  it("rejects an expired credential", async () => {
    const token = signToken({ ttlMs: 1000 });

    const result = await listPromptReports({
      authorizationHeader: `Bearer ${token}`,
      requestId: "req-5",
      now: BASE_NOW + 2000,
    });

    expect(result.status).toBe(401);
    expect(mockReportFind).not.toHaveBeenCalled();
  });

  it("rejects a revoked credential", async () => {
    const token = signToken({ jti: "revoke-in-service" });
    revokeReportReviewToken("revoke-in-service");

    const result = await listPromptReports({
      authorizationHeader: `Bearer ${token}`,
      requestId: "req-6",
      now: BASE_NOW,
    });

    expect(result.status).toBe(401);
    expect(mockReportFind).not.toHaveBeenCalled();
  });

  it("rejects a verified credential with the wrong role", async () => {
    const token = signToken({ role: "buyer" });

    const result = await listPromptReports({
      authorizationHeader: `Bearer ${token}`,
      requestId: "req-7",
      now: BASE_NOW,
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Forbidden" });
    expect(mockReportFind).not.toHaveBeenCalled();
  });

  it("rejects a verified credential with no report-review permission", async () => {
    const token = signToken({ role: "report_viewer" });

    const result = await listPromptReports({
      authorizationHeader: `Bearer ${token}`,
      requestId: "req-8",
      now: BASE_NOW,
    });

    expect(result.status).toBe(403);
    expect(mockReportFind).not.toHaveBeenCalled();
  });

  it("allows a valid report_reviewer and returns the allowlisted DTO", async () => {
    const token = signToken({ sub: "GREVIEWER_OK" });
    mockReportLean.mockResolvedValueOnce(sampleReports);

    const result = await listPromptReports({
      authorizationHeader: `Bearer ${token}`,
      promptId: "p1",
      requestId: "req-9",
      now: BASE_NOW + 1000,
    });

    expect(result.status).toBe(200);
    expect(mockReportFind).toHaveBeenCalledWith({ promptId: "p1" });

    const body = result.body as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toHaveProperty("id", "r1");
    expect(body[0]).toHaveProperty("promptId", "p1");
    expect(body[0]).not.toHaveProperty("reporterAddress");
    expect(body[0]).not.toHaveProperty("_id");
    expect(body[0]).not.toHaveProperty("__v");
  });

  it("allows a valid admin", async () => {
    const token = signToken({ sub: "GADMIN_OK", role: ADMIN_ROLE });
    mockReportLean.mockResolvedValueOnce(sampleReports);

    const result = await listPromptReports({
      authorizationHeader: `Bearer ${token}`,
      requestId: "req-10",
      now: BASE_NOW + 1000,
    });

    expect(result.status).toBe(200);
    expect(mockReportFind).toHaveBeenCalledWith({});
  });

  it("still filters by promptId for authorized reviewers", async () => {
    const token = signToken({});
    mockReportLean.mockResolvedValueOnce([]);

    await listPromptReports({
      authorizationHeader: `Bearer ${token}`,
      promptId: "p42",
      requestId: "req-11",
      now: BASE_NOW + 1000,
    });

    expect(mockReportFind).toHaveBeenCalledWith({ promptId: "p42" });
    expect(mockReportSort).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it("derives the audited actor from the verified credential, not request data", async () => {
    const token = signToken({ sub: "GTRUSTED_ACTOR" });
    mockReportLean.mockResolvedValueOnce([]);

    await listPromptReports({
      authorizationHeader: `Bearer ${token}`,
      promptId: "p1",
      requestId: "req-12",
      now: BASE_NOW + 1000,
    });

    const successCall = mockRecordAuditEvent.mock.calls.find(
      (call) => call[0].action === "report_review_access",
    );
    expect(successCall).toBeDefined();
    // The actor is the token's verified sub — there is no client-supplied field.
    expect(successCall[0].walletAddress).toBe("GTRUSTED_ACTOR");
  });

  it("audits successful access with safe metadata only", async () => {
    const token = signToken({ sub: "GTRUSTED_ACTOR" });
    mockReportLean.mockResolvedValueOnce(sampleReports);

    await listPromptReports({
      authorizationHeader: `Bearer ${token}`,
      promptId: "p1",
      requestId: "req-audit-success",
      now: BASE_NOW + 1000,
    });

    const successCall = mockRecordAuditEvent.mock.calls.find(
      (call) => call[0].action === "report_review_access",
    );
    expect(successCall).toBeDefined();
    expect(successCall[0]).toEqual({
      action: "report_review_access",
      result: "success",
      promptId: "p1",
      walletAddress: "GTRUSTED_ACTOR",
      requestId: "req-audit-success",
      clientIp: null,
      reason: null,
    });
  });

  it("audits denied access without leaking credentials or report contents", async () => {
    await listPromptReports({
      authorizationHeader: "Bearer supersecret.token-value",
      promptId: "p1",
      requestId: "req-audit-denied",
      now: BASE_NOW,
    });

    const deniedCall = mockRecordAuditEvent.mock.calls.find(
      (call) => call[0].action === "report_review_denied",
    );
    expect(deniedCall).toBeDefined();
    expect(deniedCall[0].reason).toBe("invalid_token");

    const serialized = JSON.stringify(mockRecordAuditEvent.mock.calls);
    expect(serialized).not.toContain("supersecret.token-value");
    expect(serialized).not.toContain("reporterAddress");
  });

  it("returns a safe 500 response (not an empty success) when retrieval fails", async () => {
    const token = signToken({});
    mockReportLean.mockRejectedValueOnce(new Error("db exploded"));

    const result = await listPromptReports({
      authorizationHeader: `Bearer ${token}`,
      requestId: "req-13",
      now: BASE_NOW + 1000,
    });

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Failed to fetch reports" });
  });
});

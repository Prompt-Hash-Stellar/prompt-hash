// @vitest-environment node

/**
 * Tests for Issue #180: review report logging must never contain the
 * free-form report reason (which may include PII, abuse descriptions, or
 * other sensitive content).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/stellar/promptHashClient", () => ({
  hasAccess: vi.fn(),
}));

import reportHandler from "./report";
import { resetReviewStore } from "../../src/lib/reviews/reviewStore";

function mockReqRes(body: Record<string, unknown>) {
  let statusCode = 0;
  let responseData: any = {};

  const req = { method: "POST", body };
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: any) {
      responseData = data;
      return this;
    },
  };

  return { req, res, getStatus: () => statusCode, getData: () => responseData };
}

describe("Review report logging (#180)", () => {
  beforeEach(() => {
    resetReviewStore();
  });

  it("never logs the sensitive/PII-bearing report reason text", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const sentinelReason =
      "SENTINEL_PII user@example.com contains credit-card-4111111111111111 abuse details";

    const { req, res } = mockReqRes({
      reviewId: "review_1",
      promptId: "1",
      reporterAddress: "GREPORTER1234567890ABCDEFGH1234567890ABCDEFGH1234567890",
      reason: sentinelReason,
    });

    await reportHandler(req, res);

    const allLoggedText = logSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(allLoggedText).not.toContain(sentinelReason);
    expect(allLoggedText).not.toContain("user@example.com");
    expect(allLoggedText).not.toContain("4111111111111111");

    logSpy.mockRestore();
  });
});

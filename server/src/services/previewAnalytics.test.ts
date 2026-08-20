jest.mock("../models/Prompt", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), updateOne: jest.fn() },
}));
jest.mock("../models/PreviewEvent", () => ({
  PreviewClaim: { create: jest.fn() },
  PreviewEvent: { create: jest.fn() },
  PreviewRateBucket: { findOneAndUpdate: jest.fn() },
}));

import Prompt from "../models/Prompt";
import { PreviewClaim, PreviewEvent, PreviewRateBucket } from "../models/PreviewEvent";
import {
  issuePreviewToken,
  looksAutomated,
  recordPreviewEvent,
  verifyPreviewToken,
} from "./previewAnalytics";

const promptId = "507f1f77bcf86cd799439011";
const input = () => ({
  promptId,
  sessionId: "stable-session-id-12345",
  token: issuePreviewToken(promptId, 1_000_000),
  ip: "203.0.113.8",
  userAgent: "Mozilla/5.0 Firefox/128",
  now: 1_000_000,
});

beforeEach(() => {
  jest.clearAllMocks();
  (Prompt.findOne as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue({ _id: promptId }) });
  (Prompt.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 1 });
  (PreviewRateBucket.findOneAndUpdate as jest.Mock).mockResolvedValue({ count: 1 });
  (PreviewClaim.create as jest.Mock).mockResolvedValue({});
  (PreviewEvent.create as jest.Mock).mockResolvedValue({});
});

describe("preview event verification", () => {
  it("accepts only an unexpired token bound to the prompt", () => {
    const token = issuePreviewToken(promptId, 10_000);
    expect(verifyPreviewToken(token, promptId, 10_001)).toBe(true);
    expect(verifyPreviewToken(token, "507f1f77bcf86cd799439012", 10_001)).toBe(false);
    expect(verifyPreviewToken(token, promptId, 10_000 + 300_001)).toBe(false);
  });

  it("filters common automated clients", () => {
    expect(looksAutomated("curl/8.0")).toBe(true);
    expect(looksAutomated("Mozilla/5.0 Chrome/126")).toBe(false);
  });

  it("counts a valid unique preview and records the raw decision", async () => {
    const result = await recordPreviewEvent(input());
    expect(result).toEqual({ status: 200, counted: true, reason: "counted" });
    expect(PreviewClaim.create).toHaveBeenCalledTimes(1);
    expect(Prompt.updateOne).toHaveBeenCalledWith({ _id: promptId }, { $inc: { previewCount: 1 } });
    expect(PreviewEvent.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: "counted" }));
  });

  it("dedupes a replay (including a claim won by another replica)", async () => {
    (PreviewClaim.create as jest.Mock).mockRejectedValue(Object.assign(new Error("duplicate"), { code: 11000 }));
    const result = await recordPreviewEvent(input());
    expect(result.reason).toBe("deduped");
    expect(Prompt.updateOne).not.toHaveBeenCalled();
    expect(PreviewEvent.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: "deduped" }));
  });

  it("rejects inactive or invalid prompt IDs without incrementing", async () => {
    (Prompt.findOne as jest.Mock).mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    const result = await recordPreviewEvent(input());
    expect(result.status).toBe(404);
    expect(PreviewClaim.create).not.toHaveBeenCalled();
    expect(Prompt.updateOne).not.toHaveBeenCalled();
    expect(PreviewEvent.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: "invalid_prompt" }));
  });

  it("filters a bot burst before it reaches the count", async () => {
    const result = await recordPreviewEvent({ ...input(), userAgent: "Googlebot/2.1" });
    expect(result.reason).toBe("bot_filtered");
    expect(PreviewRateBucket.findOneAndUpdate).not.toHaveBeenCalled();
    expect(Prompt.updateOne).not.toHaveBeenCalled();
  });

  it("rate limits a browser burst and retains the filtered event", async () => {
    (PreviewRateBucket.findOneAndUpdate as jest.Mock).mockResolvedValue({ count: 21 });
    const result = await recordPreviewEvent(input());
    expect(result.status).toBe(429);
    expect(Prompt.updateOne).not.toHaveBeenCalled();
    expect(PreviewEvent.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: "rate_limited" }));
  });
});

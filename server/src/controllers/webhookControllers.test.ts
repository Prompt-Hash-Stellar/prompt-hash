import { RegisterWebhook, GetWebhook, DeleteWebhook } from "./webhookControllers";

const mockReq = (opts: any) => {
  return {
    body: opts.body || {},
    query: opts.query || {},
    headers: opts.headers || {},
  } as any;
};

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockImplementation((code: number) => {
    res._status = code;
    return res;
  });
  res.json = jest.fn().mockImplementation((payload: any) => {
    res._json = payload;
    return res;
  });
  return res;
};

jest.mock("../utils/challengeSignature", () => ({
  verifyChallengeSignature: jest.fn(() => true),
}));

jest.mock("../db/connectDb", () => ({ __esModule: true, default: jest.fn() }));

jest.mock("../models/WebhookSubscription", () => {
  class MockSub {
    url: string;
    events: any;
    active = true;
    failureCount = 0;
    walletAddress: string;
    _id = "mockid";
    constructor(data: any) {
      this.url = data.url;
      this.events = data.events;
      this.walletAddress = data.walletAddress;
    }
    save = jest.fn().mockResolvedValue(undefined);
    static findOne = jest.fn().mockResolvedValue(null);
    static deleteOne = jest.fn().mockResolvedValue(undefined);
  }
  return { __esModule: true, default: MockSub };
});

describe("webhook controllers auth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects RegisterWebhook without signed owner", async () => {
    const req = mockReq({ body: { url: "https://example.com/hook" } });
    const res = mockRes();
    await RegisterWebhook(req, res as any);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("allows RegisterWebhook with signed owner", async () => {
    const req = mockReq({ body: { url: "https://example.com/hook", walletAddress: "GABC", signedMessage: "sig", timestamp: Date.now() } });
    const res = mockRes();
    await RegisterWebhook(req, res as any);
    expect([200, 201]).toContain(res._status);
  });

  it("rejects GetWebhook without signed owner", async () => {
    const req = mockReq({ query: {} });
    const res = mockRes();
    await GetWebhook(req, res as any);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("allows DeleteWebhook with signed owner", async () => {
    const req = mockReq({ body: { walletAddress: "GABC", signedMessage: "sig", timestamp: Date.now() } });
    const res = mockRes();
    await DeleteWebhook(req, res as any);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

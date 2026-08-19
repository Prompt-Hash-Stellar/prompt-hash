/**
 * Tests for Issue #180: registration logging must never contain a full User
 * document (email, profile text, wallet address, etc.) - only a hashed,
 * non-reversible identifier.
 */

jest.mock("../db/connectDb", () => jest.fn().mockResolvedValue(undefined));

jest.mock("../models/User", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
  },
}));

jest.mock("../models/Prompt", () => ({ __esModule: true, default: {} }));
jest.mock("../models/Report", () => ({ __esModule: true, default: {} }));

import User from "../models/User";
import { CreateUser } from "./controllers";

const mockFindOne = User.findOne as jest.Mock;

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeReq = (body: any) => ({ body } as any);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("CreateUser logging", () => {
  it("never logs the raw existing user document when a user already exists", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    const sentinelEmail = "sentinel-pii@example.com";
    mockFindOne.mockResolvedValueOnce({
      walletAddress: "gabc123",
      username: "alice",
      email: sentinelEmail,
      bio: "SENTINEL_SENSITIVE_BIO_TEXT",
    });

    const req = makeReq({ walletAddress: "GABC123" });
    const res = makeRes();

    await CreateUser(req, res);

    const allLoggedText = logSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(allLoggedText).not.toContain(sentinelEmail);
    expect(allLoggedText).not.toContain("SENTINEL_SENSITIVE_BIO_TEXT");
    expect(allLoggedText).not.toContain("gabc123");

    logSpy.mockRestore();
  });
});

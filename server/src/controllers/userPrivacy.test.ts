/**
 * Tests for GET /api/users (Issue #145).
 *
 * Anonymous callers must not be able to enumerate the raw User collection,
 * and single-record lookups must only return an explicitly allowlisted set
 * of public fields.
 */

jest.mock("../db/connectDb", () => jest.fn().mockResolvedValue(undefined));

jest.mock("../models/User", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    find: jest.fn(),
  },
}));

// controllers.ts also imports these plain-JS models at module scope; stub
// them out so the test doesn't need to transpile unrelated .js files.
jest.mock("../models/Prompt", () => ({ __esModule: true, default: {} }));
jest.mock("../models/Report", () => ({ __esModule: true, default: {} }));

import User from "../models/User";
import { GetUsers } from "./controllers";

const mockFindOne = User.findOne as jest.Mock;
const mockFind = User.find as jest.Mock;

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeReq = (url: string) => ({ url } as any);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GetUsers", () => {
  it("rejects anonymous bulk enumeration when no lookup key is provided", async () => {
    const req = makeReq("/api/users");
    const res = makeRes();

    await GetUsers(req, res);

    expect(mockFind).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns only allowlisted public fields for a walletAddress lookup", async () => {
    mockFindOne.mockResolvedValueOnce({
      walletAddress: "gabc",
      username: "alice",
      displayName: "Alice",
      bio: "hi",
      avatarUrl: "https://x/y.png",
      socialLinks: { twitter: "", github: "", website: "" },
      rating: 5,
      createdAt: new Date("2024-01-01"),
      email: "alice@example.com",
      notificationPreferences: { marketing: true },
    });

    const req = makeReq("/api/users?walletAddress=GABC");
    const res = makeRes();

    await GetUsers(req, res);

    expect(mockFindOne).toHaveBeenCalledWith({ walletAddress: "gabc" });
    expect(res.json).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload).toEqual({
      walletAddress: "gabc",
      username: "alice",
      displayName: "Alice",
      bio: "hi",
      avatarUrl: "https://x/y.png",
      socialLinks: { twitter: "", github: "", website: "" },
      rating: 5,
      createdAt: new Date("2024-01-01"),
    });
    expect(payload.email).toBeUndefined();
    expect(payload.notificationPreferences).toBeUndefined();
  });

  it("supports lookup by username and returns 404 when not found", async () => {
    mockFindOne.mockResolvedValueOnce(null);

    const req = makeReq("/api/users?username=bob");
    const res = makeRes();

    await GetUsers(req, res);

    expect(mockFindOne).toHaveBeenCalledWith({ username: "bob" });
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

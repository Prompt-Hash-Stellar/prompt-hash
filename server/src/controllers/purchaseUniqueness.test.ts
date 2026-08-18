/**
 * Tests for RecordPurchase (Issue #182).
 *
 * Concurrent purchase confirmations for the same (promptId, buyerWallet)
 * pair must result in exactly one entitlement record, using an atomic
 * upsert instead of a find-then-create race.
 */

jest.mock("../db/connectDb", () => jest.fn().mockResolvedValue(undefined));

jest.mock("../models/Prompt", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));

jest.mock("../models/Purchase", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    findOne: jest.fn(),
  },
}));

// versioningControllers.ts also imports these plain-JS/TS models at module
// scope; stub them out so the test doesn't need to transpile unrelated files.
jest.mock("../models/PromptVersion", () => ({ __esModule: true, default: {} }));
jest.mock("../models/User", () => ({ __esModule: true, default: {} }));

import Prompt from "../models/Prompt";
import Purchase from "../models/Purchase";
import { RecordPurchase } from "./versioningControllers";

const mockPromptFindById = Prompt.findById as jest.Mock;
const mockFindOneAndUpdate = Purchase.findOneAndUpdate as jest.Mock;
const mockFindOne = Purchase.findOne as jest.Mock;

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeReq = (body: any) => ({ body } as any);

beforeEach(() => {
  jest.clearAllMocks();
  mockPromptFindById.mockResolvedValue({ _id: "prompt1", currentVersionIndex: 3 });
});

describe("RecordPurchase", () => {
  it("upserts atomically and reports a new purchase as created", async () => {
    const created = new Date("2024-01-01T00:00:00Z");
    mockFindOneAndUpdate.mockResolvedValueOnce({
      promptId: "prompt1",
      buyerWallet: "gabc",
      versionIndex: 3,
      createdAt: created,
      updatedAt: created,
    });

    const req = makeReq({ promptId: "prompt1", buyerWallet: "GABC" });
    const res = makeRes();

    await RecordPurchase(req, res);

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { promptId: "prompt1", buyerWallet: "gabc" },
      expect.objectContaining({ $setOnInsert: expect.any(Object) }),
      expect.objectContaining({ upsert: true }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("returns the existing entitlement without duplicating on repeat calls", async () => {
    const created = new Date("2024-01-01T00:00:00Z");
    const updated = new Date("2024-01-02T00:00:00Z");
    mockFindOneAndUpdate.mockResolvedValueOnce({
      promptId: "prompt1",
      buyerWallet: "gabc",
      versionIndex: 3,
      createdAt: created,
      updatedAt: updated,
    });

    const req = makeReq({ promptId: "prompt1", buyerWallet: "GABC" });
    const res = makeRes();

    await RecordPurchase(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("falls back to reading the winning record on a concurrent duplicate-key race", async () => {
    const dupError = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    mockFindOneAndUpdate.mockRejectedValueOnce(dupError);
    const created = new Date("2024-01-01T00:00:00Z");
    mockFindOne.mockResolvedValueOnce({
      promptId: "prompt1",
      buyerWallet: "gabc",
      versionIndex: 3,
      createdAt: created,
      updatedAt: created,
    });

    const req = makeReq({ promptId: "prompt1", buyerWallet: "GABC" });
    const res = makeRes();

    await RecordPurchase(req, res);

    expect(mockFindOne).toHaveBeenCalledWith({ promptId: "prompt1", buyerWallet: "gabc" });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ versionIndex: 3 }),
    );
  });
});

const connectDb = jest.fn().mockResolvedValue(undefined);
const findOne = jest.fn();
const find = jest.fn();

jest.mock("../db/connectDb", () => ({ __esModule: true, default: connectDb }));
jest.mock("../models/User", () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => findOne(...args) },
}));
jest.mock("../models/Prompt", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => find(...args) },
}));
jest.mock("../models/Report", () => ({ __esModule: true, default: {} }));
jest.mock("ai", () => ({ streamText: jest.fn() }));
jest.mock("@ai-sdk/openai", () => ({ openai: jest.fn() }));
jest.mock("../services/listingValidation", () => ({ validateListingMetadata: jest.fn() }));

import type { Request, Response } from "express";
import { __resetCacheForTests } from "../services/cacheService";
import { GetPrompts } from "../controllers/controllers";

function deferred<T>() {
  // eslint-disable-next-line no-unused-vars
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function response() {
  return { json: jest.fn((value) => value) } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetCacheForTests();
  delete process.env.REDIS_URL;
});

describe("GetPrompts cache integration", () => {
  it("single-flights identical filtered requests and preserves the response", async () => {
    const prompts = deferred<Array<{ id: number }>>();
    const sort = jest.fn(() => prompts.promise);
    const populate = jest.fn(() => ({ sort }));
    findOne.mockResolvedValue({ _id: "owner-1" });
    find.mockReturnValue({ populate });

    const request = {
      url: "https://example.test/prompts?category=code&walletAddress=GABC",
    } as Request;
    const firstResponse = response();
    const secondResponse = response();

    const first = GetPrompts(request, firstResponse);
    const second = GetPrompts(request, secondResponse);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith({ walletAddress: "gabc" });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({
      listingStatus: "published",
      isActive: true,
      category: "code",
      owner: "owner-1",
    });

    const value = [{ id: 7 }];
    prompts.resolve(value);
    await expect(Promise.all([first, second])).resolves.toEqual([value, value]);
    expect(firstResponse.json).toHaveBeenCalledWith(value);
    expect(secondResponse.json).toHaveBeenCalledWith(value);
  });
});

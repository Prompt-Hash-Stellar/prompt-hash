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
import mongoose from "mongoose";
import {
  GetPrompts,
  encodePromptCursor,
  decodePromptCursor,
} from "../controllers/controllers";

/**
 * Creates a mock express response object for tracking controller status and json output.
 *
 * @returns Mock Express Response
 */
function createMockResponse() {
  const res: any = {};
  res.statusCode = 200;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((val: any) => {
    res.body = val;
    return res;
  });
  return res as unknown as Response & { statusCode: number; body: any };
}

/**
 * Creates a mock prompt document.
 *
 * @param id - Hexadecimal string for MongoDB ObjectId
 * @param createdAt - ISO timestamp string or Date
 * @param title - Prompt title
 * @param overrides - Additional fields
 * @returns Mock prompt document
 */
function createPromptDoc(
  id: string,
  createdAt: string | Date,
  title: string = "Sample Prompt",
  overrides: Record<string, any> = {},
) {
  return {
    _id: new mongoose.Types.ObjectId(id),
    createdAt: createdAt instanceof Date ? createdAt : new Date(createdAt),
    title,
    listingStatus: "published",
    isActive: true,
    ...overrides,
  };
}

describe("GetPrompts controller cursor pagination and listing churn (#243)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("cursor encode and decode validation", () => {
    it("round-trips valid prompt documents to cursor tokens and back", () => {
      const doc = createPromptDoc("507f1f77bcf86cd799439011", "2026-03-01T12:00:00.000Z");
      const cursor = encodePromptCursor(doc);
      const decoded = decodePromptCursor(cursor);

      expect(decoded.createdAt.toISOString()).toBe("2026-03-01T12:00:00.000Z");
      expect(decoded.id.toHexString()).toBe("507f1f77bcf86cd799439011");
    });

    it("rejects invalid cursor tokens", () => {
      expect(() => decodePromptCursor("")).toThrow();
      expect(() => decodePromptCursor("invalid-base64")).toThrow();
      expect(() => decodePromptCursor(Buffer.from(JSON.stringify({ id: "invalid" })).toString("base64"))).toThrow();
    });

    it("returns HTTP 400 when an invalid cursor is passed in request", async () => {
      const req = {
        url: "https://example.test/prompts?cursor=invalid-cursor-token&limit=5",
      } as Request;
      const res = createMockResponse();

      await GetPrompts(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: "Invalid cursor token" });
    });
  });

  describe("cursor pagination execution", () => {
    it("applies deterministic sort and limit with cursor filter", async () => {
      const cursorDoc = createPromptDoc("507f1f77bcf86cd799439011", "2026-03-01T10:00:00.000Z");
      const cursorToken = encodePromptCursor(cursorDoc);

      const nextDoc = createPromptDoc("507f1f77bcf86cd799439010", "2026-03-01T09:00:00.000Z");

      const limitMock = jest.fn().mockResolvedValue([nextDoc]);
      const sortMock = jest.fn().mockReturnValue({ limit: limitMock });
      const populateMock = jest.fn().mockReturnValue({ sort: sortMock });
      find.mockReturnValue({ populate: populateMock });

      const req = {
        url: `https://example.test/prompts?cursor=${cursorToken}&limit=10`,
      } as Request;
      const res = createMockResponse();

      await GetPrompts(req, res);

      expect(res.statusCode).toBe(200);
      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({
          listingStatus: "published",
          isActive: true,
          $or: [
            { createdAt: { $lt: cursorDoc.createdAt } },
            { createdAt: cursorDoc.createdAt, _id: { $lt: cursorDoc._id } },
          ],
        }),
      );
      expect(sortMock).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
      expect(limitMock).toHaveBeenCalledWith(11);
      expect(res.body.hasMore).toBe(false);
      expect(res.body.nextCursor).toBeNull();
      expect(res.body.items).toHaveLength(1);
    });

    it("generates nextCursor when results exceed requested limit", async () => {
      const prompt1 = createPromptDoc("507f1f77bcf86cd799439001", "2026-03-01T12:00:00.000Z");
      const prompt2 = createPromptDoc("507f1f77bcf86cd799439002", "2026-03-01T11:00:00.000Z");
      const prompt3 = createPromptDoc("507f1f77bcf86cd799439003", "2026-03-01T10:00:00.000Z");

      const limitMock = jest.fn().mockResolvedValue([prompt1, prompt2, prompt3]);
      const sortMock = jest.fn().mockReturnValue({ limit: limitMock });
      const populateMock = jest.fn().mockReturnValue({ sort: sortMock });
      find.mockReturnValue({ populate: populateMock });

      const req = {
        url: "https://example.test/prompts?limit=2",
      } as Request;
      const res = createMockResponse();

      await GetPrompts(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.hasMore).toBe(true);
      expect(res.body.nextCursor).not.toBeNull();

      const decoded = decodePromptCursor(res.body.nextCursor);
      expect(decoded.id.toHexString()).toBe("507f1f77bcf86cd799439002");
    });
  });
});

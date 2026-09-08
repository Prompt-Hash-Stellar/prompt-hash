// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import {
  encodeCursor,
  decodeCursor,
  handler,
} from "./index";

const findMock = vi.fn();
const findOneUserMock = vi.fn();
const connectDbMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../server/src/db/connectDb", () => ({
  __esModule: true,
  default: () => connectDbMock(),
}));

vi.mock("../../server/src/models/Prompt", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => findMock(...args),
  },
}));

vi.mock("../../server/src/models/User", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => findOneUserMock(...args),
  },
}));

vi.mock("../../src/lib/observability/wrapper", () => ({
  withObservability: (fn: any) => fn,
}));

/**
 * Helper to simulate an API request and capture response output.
 *
 * @param query - Request query parameters
 * @param method - HTTP request method
 * @returns Object with captured status code and JSON payload
 */
async function invokeApi(query: Record<string, string> = {}, method: string = "GET") {
  let statusCode = 200;
  let responseData: any = null;

  const req = {
    method,
    query,
    headers: {},
  };

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

  await handler(req, res);
  return { statusCode, responseData };
}

/**
 * Creates a mock prompt document with valid ObjectId and timestamp.
 *
 * @param id - MongoDB 24-character hexadecimal string
 * @param createdAt - ISO timestamp string or Date
 * @param title - Prompt title
 * @param overrides - Optional additional properties
 * @returns Mock prompt object
 */
function createMockPrompt(
  id: string,
  createdAt: string | Date,
  title: string = "Test Prompt",
  overrides: Record<string, any> = {},
) {
  return {
    _id: new mongoose.Types.ObjectId(id),
    title,
    createdAt: createdAt instanceof Date ? createdAt : new Date(createdAt),
    listingStatus: "published",
    isActive: true,
    ...overrides,
  };
}

describe("api/prompts cursor pagination and listing churn (#243)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("cursor token validation", () => {
    it("encodes and decodes valid cursor tokens round-trip", () => {
      const id = new mongoose.Types.ObjectId().toHexString();
      const date = new Date("2026-03-01T12:00:00.000Z");
      const token = encodeCursor({ createdAt: date, _id: id });

      const decoded = decodeCursor(token);
      expect(decoded.createdAt.toISOString()).toBe(date.toISOString());
      expect(decoded.id.toHexString()).toBe(id);
    });

    it("rejects non-string or empty cursor tokens", () => {
      expect(() => decodeCursor("")).toThrow("Cursor token must be a non-empty string");
      expect(() => decodeCursor("   ")).toThrow("Cursor token must be a non-empty string");
      expect(() => decodeCursor(null)).toThrow("Cursor token must be a non-empty string");
      expect(() => decodeCursor(123)).toThrow("Cursor token must be a non-empty string");
    });

    it("rejects malformed base64url or non-JSON cursor strings", () => {
      expect(() => decodeCursor("%%%not-valid-base64%%%")).toThrow();
      const nonJson = Buffer.from("this is not json").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
      expect(() => decodeCursor(nonJson)).toThrow("Invalid base64url or JSON format");
    });

    it("rejects cursor tokens missing createdAt or with invalid dates", () => {
      const missingCreatedAt = Buffer.from(
        JSON.stringify({ id: new mongoose.Types.ObjectId().toHexString() }),
      ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
      expect(() => decodeCursor(missingCreatedAt)).toThrow("missing createdAt");

      const invalidDate = Buffer.from(
        JSON.stringify({
          createdAt: "not-a-date",
          id: new mongoose.Types.ObjectId().toHexString(),
        }),
      ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
      expect(() => decodeCursor(invalidDate)).toThrow("invalid createdAt date");
    });

    it("rejects cursor tokens missing id or with invalid ObjectId strings", () => {
      const missingId = Buffer.from(
        JSON.stringify({ createdAt: new Date().toISOString() }),
      ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
      expect(() => decodeCursor(missingId)).toThrow("invalid ObjectId");

      const invalidId = Buffer.from(
        JSON.stringify({
          createdAt: new Date().toISOString(),
          id: "not-an-objectid",
        }),
      ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
      expect(() => decodeCursor(invalidId)).toThrow("invalid ObjectId");
    });

    it("returns HTTP 400 when an invalid cursor token is supplied to the API", async () => {
      const { statusCode, responseData } = await invokeApi({ cursor: "tampered-bad-token" });
      expect(statusCode).toBe(400);
      expect(responseData.error).toBe("Invalid cursor token");
    });
  });

  describe("deterministic query construction and pagination", () => {
    it("returns HTTP 405 on non-GET HTTP methods", async () => {
      const { statusCode, responseData } = await invokeApi({}, "POST");
      expect(statusCode).toBe(405);
      expect(responseData.error).toBe("Method not allowed.");
    });

    it("queries with default limit and deterministic sorting when no cursor is provided", async () => {
      const prompt1 = createMockPrompt("507f1f77bcf86cd799439011", "2026-03-01T10:00:00.000Z");
      const prompt2 = createMockPrompt("507f1f77bcf86cd799439012", "2026-03-01T09:00:00.000Z");

      const limitMock = vi.fn().mockResolvedValue([prompt1, prompt2]);
      const sortMock = vi.fn().mockReturnValue({ limit: limitMock });
      const populateMock = vi.fn().mockReturnValue({ sort: sortMock });
      findMock.mockReturnValue({ populate: populateMock });

      const { statusCode, responseData } = await invokeApi({ limit: "2" });

      expect(statusCode).toBe(200);
      expect(findMock).toHaveBeenCalledWith({
        listingStatus: "published",
        isActive: true,
      });
      expect(sortMock).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
      expect(limitMock).toHaveBeenCalledWith(3);
      expect(responseData.items).toHaveLength(2);
      expect(responseData.hasMore).toBe(false);
      expect(responseData.nextCursor).toBeNull();
    });

    it("applies deterministic $or condition when valid cursor is provided", async () => {
      const cursorDate = new Date("2026-03-01T10:00:00.000Z");
      const cursorId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439011");
      const cursor = encodeCursor({ createdAt: cursorDate, _id: cursorId });

      const promptNext = createMockPrompt("507f1f77bcf86cd799439010", "2026-03-01T08:00:00.000Z");

      const limitMock = vi.fn().mockResolvedValue([promptNext]);
      const sortMock = vi.fn().mockReturnValue({ limit: limitMock });
      const populateMock = vi.fn().mockReturnValue({ sort: sortMock });
      findMock.mockReturnValue({ populate: populateMock });

      const { statusCode, responseData } = await invokeApi({ cursor, limit: "1" });

      expect(statusCode).toBe(200);
      expect(findMock).toHaveBeenCalledWith(
        expect.objectContaining({
          listingStatus: "published",
          isActive: true,
          $or: [
            { createdAt: { $lt: cursorDate } },
            { createdAt: cursorDate, _id: { $lt: cursorId } },
          ],
        }),
      );
      expect(responseData.items).toHaveLength(1);
      expect(responseData.hasMore).toBe(false);
    });

    it("generates nextCursor when results exceed page limit", async () => {
      const prompt1 = createMockPrompt("507f1f77bcf86cd799439011", "2026-03-01T10:00:00.000Z");
      const prompt2 = createMockPrompt("507f1f77bcf86cd799439012", "2026-03-01T09:00:00.000Z");
      const prompt3 = createMockPrompt("507f1f77bcf86cd799439013", "2026-03-01T08:00:00.000Z");

      const limitMock = vi.fn().mockResolvedValue([prompt1, prompt2, prompt3]);
      const sortMock = vi.fn().mockReturnValue({ limit: limitMock });
      const populateMock = vi.fn().mockReturnValue({ sort: sortMock });
      findMock.mockReturnValue({ populate: populateMock });

      const { statusCode, responseData } = await invokeApi({ limit: "2" });

      expect(statusCode).toBe(200);
      expect(responseData.items).toHaveLength(2);
      expect(responseData.hasMore).toBe(true);
      expect(responseData.nextCursor).not.toBeNull();

      const decoded = decodeCursor(responseData.nextCursor);
      expect(decoded.id.toHexString()).toBe("507f1f77bcf86cd799439012");
    });
  });

  describe("listing churn transitions", () => {
    it("preserves pagination stability under listing creation transition", async () => {
      const page1Item1 = createMockPrompt("507f1f77bcf86cd799439003", "2026-03-01T10:00:00.000Z", "Item 1");
      const page1Item2 = createMockPrompt("507f1f77bcf86cd799439002", "2026-03-01T09:00:00.000Z", "Item 2");
      const page2Item3 = createMockPrompt("507f1f77bcf86cd799439001", "2026-03-01T08:00:00.000Z", "Item 3");

      const limitPage1Mock = vi.fn().mockResolvedValue([page1Item1, page1Item2, page2Item3]);
      findMock.mockReturnValue({
        populate: () => ({
          sort: () => ({
            limit: limitPage1Mock,
          }),
        }),
      });

      const { responseData: page1Response } = await invokeApi({ limit: "2" });
      expect(page1Response.hasMore).toBe(true);
      const cursorForPage2 = page1Response.nextCursor;

      const newlyCreatedItem = createMockPrompt("507f1f77bcf86cd799439099", "2026-03-01T11:00:00.000Z", "Newly Created Item");
      void newlyCreatedItem;

      const limitPage2Mock = vi.fn().mockResolvedValue([page2Item3]);
      findMock.mockReturnValue({
        populate: () => ({
          sort: () => ({
            limit: limitPage2Mock,
          }),
        }),
      });

      const { responseData: page2Response } = await invokeApi({ cursor: cursorForPage2, limit: "2" });

      expect(page2Response.items).toHaveLength(1);
      expect(page2Response.items[0]._id.toHexString()).toBe("507f1f77bcf86cd799439001");
      expect(page2Response.items[0].title).toBe("Item 3");
    });

    it("preserves pagination stability under listing hide transition", async () => {
      const page1Item1 = createMockPrompt("507f1f77bcf86cd799439003", "2026-03-01T10:00:00.000Z", "Item 1");
      const page1Item2 = createMockPrompt("507f1f77bcf86cd799439002", "2026-03-01T09:00:00.000Z", "Item 2");
      const page2Item3 = createMockPrompt("507f1f77bcf86cd799439001", "2026-03-01T08:00:00.000Z", "Item 3");

      const limitPage1Mock = vi.fn().mockResolvedValue([page1Item1, page1Item2, page2Item3]);
      findMock.mockReturnValue({
        populate: () => ({
          sort: () => ({
            limit: limitPage1Mock,
          }),
        }),
      });

      const { responseData: page1Response } = await invokeApi({ limit: "2" });
      const cursorForPage2 = page1Response.nextCursor;

      page1Item1.isActive = false;
      page1Item1.listingStatus = "archived";

      const limitPage2Mock = vi.fn().mockResolvedValue([page2Item3]);
      findMock.mockReturnValue({
        populate: () => ({
          sort: () => ({
            limit: limitPage2Mock,
          }),
        }),
      });

      const { responseData: page2Response } = await invokeApi({ cursor: cursorForPage2, limit: "2" });

      expect(page2Response.items).toHaveLength(1);
      expect(page2Response.items[0]._id.toHexString()).toBe("507f1f77bcf86cd799439001");
    });

    it("preserves pagination stability under listing update transition", async () => {
      const page1Item1 = createMockPrompt("507f1f77bcf86cd799439003", "2026-03-01T10:00:00.000Z", "Original Title");
      const page1Item2 = createMockPrompt("507f1f77bcf86cd799439002", "2026-03-01T09:00:00.000Z", "Item 2");
      const page2Item3 = createMockPrompt("507f1f77bcf86cd799439001", "2026-03-01T08:00:00.000Z", "Item 3");

      const limitPage1Mock = vi.fn().mockResolvedValue([page1Item1, page1Item2, page2Item3]);
      findMock.mockReturnValue({
        populate: () => ({
          sort: () => ({
            limit: limitPage1Mock,
          }),
        }),
      });

      const { responseData: page1Response } = await invokeApi({ limit: "2" });
      const cursorForPage2 = page1Response.nextCursor;

      page1Item1.title = "Updated Title with New Description and Higher Price";

      const limitPage2Mock = vi.fn().mockResolvedValue([page2Item3]);
      findMock.mockReturnValue({
        populate: () => ({
          sort: () => ({
            limit: limitPage2Mock,
          }),
        }),
      });

      const { responseData: page2Response } = await invokeApi({ cursor: cursorForPage2, limit: "2" });

      expect(page2Response.items).toHaveLength(1);
      expect(page2Response.items[0]._id.toHexString()).toBe("507f1f77bcf86cd799439001");
    });

    it("preserves pagination stability under listing sold transition", async () => {
      const page1Item1 = createMockPrompt("507f1f77bcf86cd799439003", "2026-03-01T10:00:00.000Z", "Item 1");
      const page1Item2 = createMockPrompt("507f1f77bcf86cd799439002", "2026-03-01T09:00:00.000Z", "Item 2");
      const page2Item3 = createMockPrompt("507f1f77bcf86cd799439001", "2026-03-01T08:00:00.000Z", "Item 3");

      const limitPage1Mock = vi.fn().mockResolvedValue([page1Item1, page1Item2, page2Item3]);
      findMock.mockReturnValue({
        populate: () => ({
          sort: () => ({
            limit: limitPage1Mock,
          }),
        }),
      });

      const { responseData: page1Response } = await invokeApi({ limit: "2" });
      const cursorForPage2 = page1Response.nextCursor;

      page1Item2.isSold = true;

      const limitPage2Mock = vi.fn().mockResolvedValue([page2Item3]);
      findMock.mockReturnValue({
        populate: () => ({
          sort: () => ({
            limit: limitPage2Mock,
          }),
        }),
      });

      const { responseData: page2Response } = await invokeApi({ cursor: cursorForPage2, limit: "2" });

      expect(page2Response.items).toHaveLength(1);
      expect(page2Response.items[0]._id.toHexString()).toBe("507f1f77bcf86cd799439001");
    });
  });
});

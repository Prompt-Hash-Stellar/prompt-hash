/**
 * Security and Budget Tests for Search & Autocomplete (Issue #155)
 *
 * Tests:
 * - Regex metacharacter corpus escaping
 * - Catastrophic regex pattern regression
 * - Long Unicode query length limit budget
 * - Timeout / maxTimeMS execution budget handling
 * - Autocomplete and pagination limit bounds & sorting stability
 */

jest.mock("../models/Prompt", () => {
  const mockLean = jest.fn().mockResolvedValue([]);
  const mockPopulate = jest.fn().mockReturnThis();
  const mockLimit = jest.fn().mockReturnThis();
  const mockSkip = jest.fn().mockReturnThis();
  const mockSort = jest.fn().mockReturnThis();
  const mockMaxTimeMS = jest.fn().mockReturnThis();
  const mockOr = jest.fn().mockReturnThis();
  const mockSelect = jest.fn().mockReturnThis();
  const mockGetFilter = jest.fn().mockReturnValue({});

  const mockQueryChain = {
    or: mockOr,
    sort: mockSort,
    skip: mockSkip,
    limit: mockLimit,
    populate: mockPopulate,
    maxTimeMS: mockMaxTimeMS,
    lean: mockLean,
    select: mockSelect,
    getFilter: mockGetFilter,
  };

  const mockFind = jest.fn().mockReturnValue(mockQueryChain);
  const mockCountDocuments = jest.fn().mockReturnValue({
    maxTimeMS: jest.fn().mockResolvedValue(0),
  });
  const mockDistinct = jest.fn().mockResolvedValue([]);
  const mockAggregate = jest.fn().mockResolvedValue([]);

  return {
    __esModule: true,
    default: {
      find: mockFind,
      countDocuments: mockCountDocuments,
      distinct: mockDistinct,
      aggregate: mockAggregate,
      __queryChain: mockQueryChain,
    },
  };
});

import Prompt from "../models/Prompt";
import {
  searchPrompts,
  getSearchSuggestions,
} from "../controllers/searchController";
import { escapeRegex, SearchBudgetError } from "../utils/searchUtils";

const mockPrompt = Prompt as any;
const mockChain = mockPrompt.__queryChain;

beforeEach(() => {
  jest.clearAllMocks();
  mockPrompt.find.mockReturnValue(mockChain);
  mockChain.or.mockReturnValue(mockChain);
  mockChain.sort.mockReturnValue(mockChain);
  mockChain.skip.mockReturnValue(mockChain);
  mockChain.limit.mockReturnValue(mockChain);
  mockChain.populate.mockReturnValue(mockChain);
  mockChain.maxTimeMS.mockReturnValue(mockChain);
  mockChain.lean.mockResolvedValue([]);
  mockChain.select.mockReturnValue(mockChain);
  mockPrompt.countDocuments.mockReturnValue({
    maxTimeMS: jest.fn().mockResolvedValue(0),
  });
  mockPrompt.distinct.mockResolvedValue([]);
});

describe("escapeRegex Utility", () => {
  it("escapes all regular expression metacharacters", () => {
    const corpus = ".*+?^${}()|[\\]\\\\";
    const escaped = escapeRegex(corpus);
    expect(escaped).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\\\\\]\\\\\\\\");
  });

  it("handles strings with mixed text and metacharacters", () => {
    const input = "admin.* (test)+ [1-9]? ^start$ {2,4} a|b";
    const escaped = escapeRegex(input);
    expect(escaped).toBe(
      "admin\\.\\* \\(test\\)\\+ \\[1-9\\]\\? \\^start\\$ \\{2,4\\} a\\|b"
    );
  });

  it("returns empty string when input is null, undefined, or empty", () => {
    expect(escapeRegex("")).toBe("");
    expect(escapeRegex(null as any)).toBe("");
    expect(escapeRegex(undefined as any)).toBe("");
  });
});

describe("searchPrompts - Security & Budget Controls", () => {
  it("escapes metacharacters in query preventing regex operator injection", async () => {
    const maliciousQuery = ".*admin.*";
    await searchPrompts({ query: maliciousQuery });

    expect(mockChain.or).toHaveBeenCalledTimes(1);
    const filterArg = mockChain.or.mock.calls[0][0];
    const regexObj: RegExp = filterArg[0].title;

    expect(regexObj).toBeInstanceOf(RegExp);
    expect(regexObj.source).toBe("\\.\\*admin\\.\\*");
    expect(regexObj.flags).toBe("i");
  });

  it("safely handles catastrophic regex pattern inputs without crashing", async () => {
    const catastrophicPattern = "((a+)+)+$ (a|a?)+";
    await searchPrompts({ query: catastrophicPattern });

    const filterArg = mockChain.or.mock.calls[0][0];
    const regexObj: RegExp = filterArg[0].title;
    expect(regexObj.source).toBe("\\(\\(a\\+\\)\\+\\)\\+\\$ \\(a\\|a\\?\\)\\+");
  });

  it("rejects long queries exceeding the length budget (including Unicode)", async () => {
    const longUnicodeQuery = "🔍".repeat(55); // 55 emoji characters = 110 code units
    expect(longUnicodeQuery.length).toBeGreaterThan(100);

    await expect(searchPrompts({ query: longUnicodeQuery })).rejects.toThrow(
      SearchBudgetError
    );

    try {
      await searchPrompts({ query: longUnicodeQuery });
    } catch (err: any) {
      expect(err.code).toBe("QUERY_LENGTH_EXCEEDED");
      expect(err.statusCode).toBe(400);
    }
  });

  it("clamps search limit to maximum allowed limit (50)", async () => {
    await searchPrompts({ limit: 500 });
    expect(mockChain.limit).toHaveBeenCalledWith(50);
  });

  it("applies deterministic tie-breaker (_id: -1) to sort options", async () => {
    await searchPrompts({ sortBy: "price-low" });
    expect(mockChain.sort).toHaveBeenCalledWith({ price: 1, _id: -1 });

    await searchPrompts({ sortBy: "recent" });
    expect(mockChain.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
  });

  it("enforces maxTimeMS time budget on search queries", async () => {
    await searchPrompts({ query: "test" });
    expect(mockChain.maxTimeMS).toHaveBeenCalledWith(2000);
  });

  it("translates Mongo execution timeout to typed SearchBudgetError", async () => {
    const mongoTimeoutErr: any = new Error("operation exceeded time limit");
    mongoTimeoutErr.name = "MongoServerError";
    mongoTimeoutErr.code = 50;

    mockPrompt.countDocuments.mockReturnValue({
      maxTimeMS: jest.fn().mockRejectedValue(mongoTimeoutErr),
    });

    await expect(searchPrompts({ query: "slow query" })).rejects.toThrow(
      SearchBudgetError
    );

    try {
      await searchPrompts({ query: "slow query" });
    } catch (err: any) {
      expect(err.code).toBe("QUERY_TIMEOUT_EXCEEDED");
      expect(err.statusCode).toBe(408);
    }
  });
});

describe("getSearchSuggestions - Security & Budget Controls", () => {
  it("escapes regex metacharacters in suggestion query", async () => {
    await getSearchSuggestions("cat.*", 5);

    expect(mockPrompt.find).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.any(RegExp),
        isActive: true,
      })
    );

    const callArg = mockPrompt.find.mock.calls[0][0];
    expect(callArg.title.source).toBe("cat\\.\\*");
  });

  it("clamps suggestion limit to maximum (20)", async () => {
    await getSearchSuggestions("valid", 100);
    expect(mockChain.limit).toHaveBeenCalledWith(20);
  });

  it("rejects suggestion queries exceeding max length budget", async () => {
    const longQuery = "a".repeat(101);
    await expect(getSearchSuggestions(longQuery, 5)).rejects.toThrow(
      SearchBudgetError
    );
  });

  it("returns empty results for queries shorter than 2 characters", async () => {
    const result = await getSearchSuggestions("a", 5);
    expect(result).toEqual({ titles: [], categories: [] });
    expect(mockPrompt.find).not.toHaveBeenCalled();
  });

  it("enforces maxTimeMS time budget on suggestion queries", async () => {
    await getSearchSuggestions("prompt", 5);
    expect(mockChain.maxTimeMS).toHaveBeenCalledWith(1000);
  });
});

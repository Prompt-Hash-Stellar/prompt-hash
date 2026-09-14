import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";

// Mock the database and models
jest.mock("../../server/src/db/connectDb", () => jest.fn().mockResolvedValue(undefined));
jest.mock("../../server/src/models/Prompt", () => ({
  find: jest.fn().mockReturnValue({
    populate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  }),
}));
jest.mock("../../server/src/models/User", () => ({
  findOne: jest.fn().mockResolvedValue(null),
}));

describe("api/prompts/index cursor pagination", () => {
  it("returns nextCursor when there are more results", async () => {
    const { default: handler } = await import("./index");
    const Prompt = (await import("../../server/src/models/Prompt")) as any;

    // Mock 21 prompts (limit=20, so hasNextPage=true)
    const mockPrompts = Array.from({ length: 21 }, (_, i) => ({
      _id: `id_${String(i).padStart(2, "0")}`,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
      owner: { username: "user", walletAddress: "0x123" },
      title: `Prompt ${i}`,
      category: "test",
      content: "test content",
      price: 100,
      listingStatus: "published",
      isActive: true,
    }));

    Prompt.find.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(mockPrompts),
    });

    const req = { method: "GET", query: { limit: "20" } };
    let responseBody: any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockImplementation((body: any) => { responseBody = body; }),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(responseBody.prompts).toHaveLength(20);
    expect(responseBody.nextCursor).toBeTruthy();
  });

  it("returns null nextCursor at end of list", async () => {
    const { default: handler } = await import("./index");
    const Prompt = (await import("../../server/src/models/Prompt")) as any;

    const mockPrompts = Array.from({ length: 5 }, (_, i) => ({
      _id: `id_${i}`,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
      owner: { username: "user", walletAddress: "0x123" },
      title: `Prompt ${i}`,
      category: "test",
      content: "test content",
      price: 100,
      listingStatus: "published",
      isActive: true,
    }));

    Prompt.find.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(mockPrompts),
    });

    const req = { method: "GET", query: { limit: "20" } };
    let responseBody: any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockImplementation((body: any) => { responseBody = body; }),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(responseBody.prompts).toHaveLength(5);
    expect(responseBody.nextCursor).toBeNull();
  });

  it("rejects malformed cursor with 400", async () => {
    const { default: handler } = await import("./index");

    const req = { method: "GET", query: { cursor: "not-valid-!!!" } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("clamps limit to [1, 100]", async () => {
    const { default: handler } = await import("./index");
    const Prompt = (await import("../../server/src/models/Prompt")) as any;

    Prompt.find.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    });

    // Test with limit=0 (should clamp to 1)
    const req1 = { method: "GET", query: { limit: "0" } };
    const res1 = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await handler(req1, res1);
    expect(res1.status).toHaveBeenCalledWith(200);

    // Test with limit=500 (should clamp to 100)
    const req2 = { method: "GET", query: { limit: "500" } };
    const res2 = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await handler(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(200);
  });
});

import express from "express";
import request from "supertest";

const mockFindOne = jest.fn();
const mockFind = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateMany = jest.fn();

jest.mock("../models/FulfillmentRecord", () => ({
  __esModule: true,
  default: {
    findOne: mockFindOne,
    find: mockFind,
    findOneAndUpdate: mockFindOneAndUpdate,
    updateMany: mockUpdateMany,
  },
}));

import { fulfillmentRouter } from "./fulfillmentRoutes";

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/api/fulfillment", fulfillmentRouter);
  return app;
};

describe("fulfillment route authorization and state guards", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.UNLOCK_SERVICE_TOKEN = "unlock-secret";
    process.env.SCHEDULER_TOKEN = "scheduler-secret";
    process.env.ADMIN_ROTATION_TOKEN = "admin-secret";
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  it("requires a service credential before creating a fulfillment update", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/fulfillment")
      .send({ promptId: "p1", buyerWallet: "0xBuyer1", status: "failed" });

    expect(res.status).toBe(401);
  });

  it("denies refund requests from a different wallet", async () => {
    const app = buildApp();
    const save = jest.fn().mockResolvedValue(true);
    mockFindOne.mockResolvedValue({
      promptId: "p1",
      buyerWallet: "0xbuyer1",
      status: "failed",
      auditLog: [],
      isRefundEligible: () => true,
      save,
    });

    const res = await request(app)
      .post("/api/fulfillment/p1/0xbuyer1/request-refund")
      .set("X-Wallet-Address", "0xbuyer2")
      .send({ reason: "Delivery failed" });

    expect(res.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects stale state transitions that do not match the expected status", async () => {
    const app = buildApp();
    mockFindOne.mockResolvedValue({
      promptId: "p1",
      buyerWallet: "0xbuyer1",
      status: "refunded",
      auditLog: [],
      save: jest.fn(),
    });

    const res = await request(app)
      .post("/api/fulfillment/p1/0xbuyer1/resolve")
      .set("Authorization", "Bearer admin-secret")
      .send({ refund: true, expectedStatus: "refund_requested" });

    expect(res.status).toBe(409);
  });

  it("requires scheduler authorization for the sweep endpoint", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/fulfillment/auto-refund-sweep")
      .send({});

    expect(res.status).toBe(401);
  });
});

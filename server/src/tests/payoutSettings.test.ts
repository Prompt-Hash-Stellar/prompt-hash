import { Keypair } from "@stellar/stellar-sdk";

const memoRequiredAddress = Keypair.random().publicKey();
const notFundedAddress = Keypair.random().publicKey();

jest.mock("../config/stellar", () => ({
  stellarConfig: {
    PUBLIC_STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
  },
}));

jest.mock("@stellar/stellar-sdk", () => {
  const original = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...original,
    Horizon: {
      Server: jest.fn().mockImplementation(() => {
        return {
          accounts: () => ({
            accountId: (address: string) => ({
              call: async () => {
                if (address === memoRequiredAddress) {
                  return { data_attr: { "config.memo_required": "MQ==" } };
                }
                if (address === notFundedAddress) {
                  const err: any = new Error("Not found");
                  err.response = { status: 404 };
                  throw err;
                }
                return { data_attr: {} };
              }
            })
          })
        };
      })
    }
  };
});

import mongoose from "mongoose";
import request from "supertest";
import express from "express";
import User from "../models/User";
import { userRouter } from "../routes/userRoutes";
import { AuditLog } from "../models/AuditLog";
import connectDb from "../db/connectDb";

const app = express();
app.use(express.json());
app.use("/api/user", userRouter);

const describeWithDb = process.env.MONGODB_URI ? describe : describe.skip;

describeWithDb("Payout Settings", () => {
  let userWallet: string;
  let userKeypair: Keypair;
  
  beforeAll(async () => {
    await connectDb();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await AuditLog.deleteMany({});

    userKeypair = Keypair.random();
    userWallet = userKeypair.publicKey();
    
    await User.create({
      walletAddress: userWallet.toLowerCase(),
      username: "testuser",
      rating: 4,
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  it("should enforce StrKey validation for payout address", async () => {
    const timestamp = Date.now();
    const targetAddress = "invalid-address";
    const message = `prompt-hash:update-payout:${targetAddress}:${timestamp}`;
    const signature = userKeypair.sign(Buffer.from(message)).toString("base64");

    const res = await request(app)
      .post(`/api/user/${userWallet}/payout-settings`)
      .send({ payoutAddress: targetAddress, signature, signedMessage: message });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid Stellar payout address");
  });

  it("should apply cooling-off window for destination updates", async () => {
    const targetKeypair = Keypair.random();
    const targetAddress = targetKeypair.publicKey();
    const timestamp = Date.now();
    const message = `prompt-hash:update-payout:${targetAddress}:${timestamp}`;
    const signature = userKeypair.sign(Buffer.from(message)).toString("base64");

    const res = await request(app)
      .post(`/api/user/${userWallet}/payout-settings`)
      .send({ payoutAddress: targetAddress, signature, signedMessage: message });

    expect(res.status).toBe(200);
    expect(res.body.pendingPayoutAddress).toBe(targetAddress);
    expect(res.body.payoutAddress).toBe(userWallet.toLowerCase());
  });

  it("should prevent replay attacks by enforcing timestamp freshness", async () => {
    const targetKeypair = Keypair.random();
    const targetAddress = targetKeypair.publicKey();
    const timestamp = Date.now() - 10 * 60 * 1000;
    const message = `prompt-hash:update-payout:${targetAddress}:${timestamp}`;
    const signature = userKeypair.sign(Buffer.from(message)).toString("base64");

    const res = await request(app)
      .post(`/api/user/${userWallet}/payout-settings`)
      .send({ payoutAddress: targetAddress, signature, signedMessage: message });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("expired");
  });

  it("should prevent cross-wallet change (invalid signature)", async () => {
    const targetKeypair = Keypair.random();
    const targetAddress = targetKeypair.publicKey();
    const timestamp = Date.now();
    const message = `prompt-hash:update-payout:${targetAddress}:${timestamp}`;
    const attackerKeypair = Keypair.random();
    const signature = attackerKeypair.sign(Buffer.from(message)).toString("base64");

    const res = await request(app)
      .post(`/api/user/${userWallet}/payout-settings`)
      .send({ payoutAddress: targetAddress, signature, signedMessage: message });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid signature");
  });

  it("should reject unfunded destination accounts", async () => {
    const timestamp = Date.now();
    const targetAddress = notFundedAddress;
    const message = `prompt-hash:update-payout:${targetAddress}:${timestamp}`;
    const signature = userKeypair.sign(Buffer.from(message)).toString("base64");

    const res = await request(app)
      .post(`/api/user/${userWallet}/payout-settings`)
      .send({ payoutAddress: targetAddress, signature, signedMessage: message });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not funded");
  });

  it("should reject memo-required destination if provided as G-address", async () => {
    const timestamp = Date.now();
    const targetAddress = memoRequiredAddress;
    const message = `prompt-hash:update-payout:${targetAddress}:${timestamp}`;
    const signature = userKeypair.sign(Buffer.from(message)).toString("base64");

    const res = await request(app)
      .post(`/api/user/${userWallet}/payout-settings`)
      .send({ payoutAddress: targetAddress, signature, signedMessage: message });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Destination requires a memo");
  });
});

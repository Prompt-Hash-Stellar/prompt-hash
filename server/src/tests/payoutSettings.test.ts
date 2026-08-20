import mongoose from "mongoose";
import request from "supertest";
import express from "express";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import User from "../models/User";
import { userRouter } from "../routes/userRoutes";
import { AuditLog } from "../models/AuditLog";
import connectDb from "../db/connectDb";

// Setup express app for testing
const app = express();
app.use(express.json());
app.use("/api/user", userRouter);

// Requires a live MongoDB; skip in environments (like CI) without MONGODB_URI.
const describeWithDb = process.env.MONGODB_URI ? describe : describe.skip;

describeWithDb("Payout Settings", () => {
  let userWallet: string;
  let userKeypair: Keypair;
  
  beforeAll(async () => {
    // Connect to a test db or mock mongoose
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
      .send({
        payoutAddress: targetAddress,
        signature,
        signedMessage: message,
      });

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
      .send({
        payoutAddress: targetAddress,
        signature,
        signedMessage: message,
      });

    expect(res.status).toBe(200);
    expect(res.body.pendingPayoutAddress).toBe(targetAddress);
    expect(res.body.payoutAddress).toBe(userWallet.toLowerCase()); // or userWallet since it was default
    expect(new Date(res.body.payoutAddressEffectiveAt).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000); // approx 24h

    // Verify audit log
    const audit = await AuditLog.findOne({ action: "payout_update_success" });
    expect(audit).not.toBeNull();
  });

  it("should prevent replay attacks by enforcing timestamp freshness", async () => {
    const targetKeypair = Keypair.random();
    const targetAddress = targetKeypair.publicKey();
    const timestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const message = `prompt-hash:update-payout:${targetAddress}:${timestamp}`;
    const signature = userKeypair.sign(Buffer.from(message)).toString("base64");

    const res = await request(app)
      .post(`/api/user/${userWallet}/payout-settings`)
      .send({
        payoutAddress: targetAddress,
        signature,
        signedMessage: message,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("expired");
  });

  it("should prevent cross-wallet change (invalid signature)", async () => {
    const targetKeypair = Keypair.random();
    const targetAddress = targetKeypair.publicKey();
    const timestamp = Date.now();
    const message = `prompt-hash:update-payout:${targetAddress}:${timestamp}`;
    
    // Sign with a DIFFERENT keypair (attacker)
    const attackerKeypair = Keypair.random();
    const signature = attackerKeypair.sign(Buffer.from(message)).toString("base64");

    const res = await request(app)
      .post(`/api/user/${userWallet}/payout-settings`)
      .send({
        payoutAddress: targetAddress,
        signature,
        signedMessage: message,
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid signature");
  });
});

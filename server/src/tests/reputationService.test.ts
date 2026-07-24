/**
 * Tests for sybil-resistant review eligibility & versioned reputation
 * snapshots — Issue #109.
 */

function mockQuery(result: any) {
  const q: any = {
    populate: () => q,
    sort: () => q,
    lean: () => Promise.resolve(result),
    distinct: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

const mockPromptFindById = jest.fn();
const mockPromptFind = jest.fn();
const mockPurchaseFindOne = jest.fn();
const mockPurchaseFind = jest.fn();
const mockPurchaseFindByIdAndUpdate = jest.fn();
const mockReviewFindOne = jest.fn();
const mockReviewFind = jest.fn();
const mockReviewCreate = jest.fn();
const mockReviewFindById = jest.fn();
const mockReviewFlagCreate = jest.fn();
const mockReviewFlagFind = jest.fn();
const mockReviewFlagFindById = jest.fn();
const mockReviewAppealCreate = jest.fn();
const mockReviewAppealFindById = jest.fn();
const mockSnapshotCreate = jest.fn();
const mockSnapshotFindOne = jest.fn();
const mockSnapshotFind = jest.fn();
const mockFulfillmentFindOne = jest.fn();

jest.mock("../models/Prompt", () => ({
  __esModule: true,
  default: { findById: mockPromptFindById, find: mockPromptFind },
}));

jest.mock("../models/Purchase", () => ({
  __esModule: true,
  default: {
    findOne: mockPurchaseFindOne,
    find: mockPurchaseFind,
    findByIdAndUpdate: mockPurchaseFindByIdAndUpdate,
  },
}));

jest.mock("../models/Review", () => ({
  __esModule: true,
  default: {
    findOne: mockReviewFindOne,
    find: mockReviewFind,
    create: mockReviewCreate,
    findById: mockReviewFindById,
  },
}));

jest.mock("../models/ReviewFlag", () => ({
  __esModule: true,
  default: {
    create: mockReviewFlagCreate,
    find: mockReviewFlagFind,
    findById: mockReviewFlagFindById,
  },
}));

jest.mock("../models/ReviewAppeal", () => ({
  __esModule: true,
  default: {
    create: mockReviewAppealCreate,
    findById: mockReviewAppealFindById,
  },
}));

jest.mock("../models/ReputationSnapshot", () => ({
  __esModule: true,
  default: {
    create: mockSnapshotCreate,
    findOne: mockSnapshotFindOne,
    find: mockSnapshotFind,
  },
}));

jest.mock("../models/FulfillmentRecord", () => ({
  __esModule: true,
  default: { findOne: mockFulfillmentFindOne },
}));

import {
  checkReviewEligibility,
  detectAbuseSignals,
  submitReview,
  editReview,
  deleteReview,
  markPurchaseFraud,
  invalidateReviewForRefund,
  fileAppeal,
  resolveAppeal,
  computeReputation,
  recomputeReputationSnapshot,
  ReputationError,
} from "../services/reputationService";
import { EligibilityCode, AbuseFlagCode } from "../config/explanationCodes";

const CREATOR_A = "gcreatora";
const CREATOR_B = "gcreatorb";
const BUYER_1 = "gbuyer1";
const BUYER_2 = "gbuyer2";

function prompt(id: string, ownerWallet: string) {
  return { _id: id, owner: { walletAddress: ownerWallet } };
}

const OLD_ENOUGH = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
const TOO_RECENT = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago

beforeEach(() => {
  jest.clearAllMocks();
  mockReviewFlagCreate.mockImplementation((data) => Promise.resolve({ _id: "flag-1", ...data, save: jest.fn() }));
  mockReviewCreate.mockImplementation((data) =>
    Promise.resolve({ _id: "review-1", ...data, history: [], save: jest.fn() }),
  );
  mockSnapshotCreate.mockImplementation((data) => Promise.resolve({ _id: "snap-1", ...data }));
  mockReviewAppealCreate.mockImplementation((data) => Promise.resolve({ _id: "appeal-1", ...data }));
  mockSnapshotFindOne.mockReturnValue(mockQuery(null));
  mockReviewFlagFind.mockReturnValue(mockQuery([]));
  mockFulfillmentFindOne.mockReturnValue(mockQuery(null));
  mockReviewFind.mockReturnValue(mockQuery([]));
  mockPurchaseFind.mockReturnValue(mockQuery([]));
});

describe("checkReviewEligibility — self-dealing", () => {
  it("rejects a creator reviewing their own prompt", async () => {
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));

    const result = await checkReviewEligibility("p1", CREATOR_A);

    expect(result.eligible).toBe(false);
    expect(result.code).toBe(EligibilityCode.SELF_REVIEW);
  });
});

describe("checkReviewEligibility — purchase & window checks", () => {
  it("rejects when no purchase exists", async () => {
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));
    mockPurchaseFindOne.mockReturnValue(mockQuery(null));

    const result = await checkReviewEligibility("p1", BUYER_1);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe(EligibilityCode.NO_PURCHASE);
  });

  it("rejects when the purchase was refunded", async () => {
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));
    mockPurchaseFindOne.mockReturnValue(
      mockQuery({ _id: "pur-1", promptId: "p1", buyerWallet: BUYER_1, createdAt: OLD_ENOUGH, fraudConfirmed: false }),
    );
    mockFulfillmentFindOne.mockReturnValue(mockQuery({ status: "refunded" }));

    const result = await checkReviewEligibility("p1", BUYER_1);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe(EligibilityCode.PURCHASE_REFUNDED);
  });

  it("rejects when the interaction window has not elapsed", async () => {
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));
    mockPurchaseFindOne.mockReturnValue(
      mockQuery({ _id: "pur-1", promptId: "p1", buyerWallet: BUYER_1, createdAt: TOO_RECENT, fraudConfirmed: false }),
    );
    mockReviewFindOne.mockReturnValue(mockQuery(null));

    const result = await checkReviewEligibility("p1", BUYER_1);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe(EligibilityCode.INTERACTION_WINDOW_NOT_ELAPSED);
  });

  it("allows a verified, non-refunded purchase past the interaction window", async () => {
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));
    mockPurchaseFindOne.mockReturnValue(
      mockQuery({ _id: "pur-1", promptId: "p1", buyerWallet: BUYER_1, createdAt: OLD_ENOUGH, fraudConfirmed: false }),
    );
    mockReviewFindOne.mockReturnValue(mockQuery(null));

    const result = await checkReviewEligibility("p1", BUYER_1);
    expect(result.eligible).toBe(true);
    expect(result.code).toBe(EligibilityCode.ELIGIBLE);
  });

  it("rejects a second review against the same purchase (one review per purchase)", async () => {
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));
    mockPurchaseFindOne.mockReturnValue(
      mockQuery({ _id: "pur-1", promptId: "p1", buyerWallet: BUYER_1, createdAt: OLD_ENOUGH, fraudConfirmed: false }),
    );
    mockReviewFindOne.mockReturnValue(mockQuery({ _id: "review-existing" }));

    const result = await checkReviewEligibility("p1", BUYER_1);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe(EligibilityCode.ALREADY_REVIEWED);
  });
});

describe("detectAbuseSignals — reciprocal reviews", () => {
  it("flags a reciprocal ring when the seller already reviewed the reviewer's prompt", async () => {
    mockPromptFind.mockReturnValue(
      mockQuery([prompt("p-seller", CREATOR_A), prompt("p-reviewer", BUYER_1)]),
    );
    mockReviewFindOne.mockReturnValue(mockQuery({ _id: "reciprocal-review" }));

    const flags = await detectAbuseSignals({
      promptId: "p-seller",
      reviewerWallet: BUYER_1,
      sellerWallet: CREATOR_A,
      purchase: {},
    });

    expect(flags).toContain(AbuseFlagCode.RECIPROCAL_RING);
  });

  it("does not flag when the reviewer owns no prompts", async () => {
    mockPromptFind.mockReturnValue(mockQuery([prompt("p-seller", CREATOR_A)]));

    const flags = await detectAbuseSignals({
      promptId: "p-seller",
      reviewerWallet: BUYER_1,
      sellerWallet: CREATOR_A,
      purchase: {},
    });

    expect(flags).not.toContain(AbuseFlagCode.RECIPROCAL_RING);
  });
});

describe("detectAbuseSignals — burst wallets", () => {
  it("flags a burst of distinct-wallet reviews within the burst window", async () => {
    mockPromptFind.mockReturnValue(mockQuery([prompt("p-seller", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery(["w1", "w2", "w3", "w4", "w5"]));

    const flags = await detectAbuseSignals({
      promptId: "p-seller",
      reviewerWallet: BUYER_1,
      sellerWallet: CREATOR_A,
      purchase: {},
    });

    expect(flags).toContain(AbuseFlagCode.BURST_PATTERN);
  });

  it("does not flag a normal trickle of reviews", async () => {
    mockPromptFind.mockReturnValue(mockQuery([prompt("p-seller", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery(["w1"]));

    const flags = await detectAbuseSignals({
      promptId: "p-seller",
      reviewerWallet: BUYER_1,
      sellerWallet: CREATOR_A,
      purchase: {},
    });

    expect(flags).not.toContain(AbuseFlagCode.BURST_PATTERN);
  });
});

describe("detectAbuseSignals — review rings (linked-wallet clusters)", () => {
  it("flags when another buyer shares the same funding-source hash", async () => {
    mockPromptFind.mockReturnValue(mockQuery([prompt("p-seller", CREATOR_A)]));
    mockPurchaseFind.mockReturnValue(mockQuery([BUYER_1, BUYER_2]));

    const flags = await detectAbuseSignals({
      promptId: "p-seller",
      reviewerWallet: BUYER_1,
      sellerWallet: CREATOR_A,
      purchase: { fundingSourceHash: "shared-hash-abc" },
    });

    expect(flags).toContain(AbuseFlagCode.LINKED_WALLET_CLUSTER);
  });

  it("does not flag when no funding-source hash is recorded", async () => {
    mockPromptFind.mockReturnValue(mockQuery([prompt("p-seller", CREATOR_A)]));

    const flags = await detectAbuseSignals({
      promptId: "p-seller",
      reviewerWallet: BUYER_1,
      sellerWallet: CREATOR_A,
      purchase: {},
    });

    expect(flags).not.toContain(AbuseFlagCode.LINKED_WALLET_CLUSTER);
  });
});

describe("submitReview", () => {
  it("throws a ReputationError when ineligible", async () => {
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));

    await expect(submitReview({ promptId: "p1", reviewerWallet: CREATOR_A, rating: 5 })).rejects.toThrow(
      ReputationError,
    );
  });

  it("creates a review and a new reputation snapshot on success", async () => {
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));
    mockPurchaseFindOne.mockReturnValue(
      mockQuery({ _id: "pur-1", promptId: "p1", buyerWallet: BUYER_1, createdAt: OLD_ENOUGH, fraudConfirmed: false }),
    );
    mockReviewFindOne.mockReturnValue(mockQuery(null));
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery([{ _id: "review-1", rating: 5, createdAt: new Date() }]));

    const { review, flagCodes, snapshot } = await submitReview({
      promptId: "p1",
      reviewerWallet: BUYER_1,
      rating: 5,
      text: "great prompt",
    });

    expect(review).toBeDefined();
    expect(flagCodes).toEqual([]);
    expect(mockSnapshotCreate).toHaveBeenCalledTimes(1);
    expect(snapshot.reason).toBe("review_added");
    expect(snapshot.sampleSize).toBe(1);
  });
});

describe("editReview / deleteReview — auditable, non-destructive history", () => {
  it("edit preserves prior rating/text in history and recomputes a new snapshot", async () => {
    const save = jest.fn();
    mockReviewFindById.mockResolvedValue({
      _id: "review-1",
      userAddress: BUYER_1,
      promptId: "p1",
      rating: 3,
      text: "meh",
      status: "active",
      version: 1,
      history: [],
      save,
    });
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery([]));

    const { review, snapshot } = await editReview({
      reviewId: "review-1",
      reviewerWallet: BUYER_1,
      rating: 5,
      text: "actually great",
    });

    expect(review.history).toEqual([{ rating: 3, text: "meh", editedAt: expect.any(Date) }]);
    expect(review.rating).toBe(5);
    expect(review.status).toBe("edited");
    expect(save).toHaveBeenCalled();
    expect(snapshot.reason).toBe("review_edited");
  });

  it("rejects edits from a wallet that does not own the review", async () => {
    mockReviewFindById.mockResolvedValue({
      _id: "review-1",
      userAddress: BUYER_1,
      status: "active",
      history: [],
      save: jest.fn(),
    });

    await expect(
      editReview({ reviewId: "review-1", reviewerWallet: BUYER_2, rating: 1 }),
    ).rejects.toThrow(ReputationError);
  });

  it("soft-deletes a review (status flips, document is preserved) and recomputes a snapshot", async () => {
    const save = jest.fn();
    mockReviewFindById.mockResolvedValue({
      _id: "review-1",
      userAddress: BUYER_1,
      promptId: "p1",
      status: "active",
      save,
    });
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery([]));

    const { review, snapshot } = await deleteReview({ reviewId: "review-1", reviewerWallet: BUYER_1 });

    expect(review.status).toBe("deleted");
    expect(review.deletedAt).toBeInstanceOf(Date);
    expect(save).toHaveBeenCalled();
    expect(snapshot.reason).toBe("review_deleted");
  });
});

describe("refund and confirmed fraud invalidate reviews via a new snapshot", () => {
  it("invalidateReviewForRefund flags the review tied to the refunded purchase", async () => {
    mockPurchaseFindOne.mockReturnValue(
      mockQuery({ _id: "pur-1", promptId: "p1", buyerWallet: BUYER_1 }),
    );
    mockReviewFindOne.mockReturnValue(mockQuery({ _id: "review-1" }));
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery([]));

    const result = await invalidateReviewForRefund("p1", BUYER_1);

    expect(mockReviewFlagCreate).toHaveBeenCalledWith(
      expect.objectContaining({ code: AbuseFlagCode.REFUND_INVALIDATED, reviewId: "review-1" }),
    );
    expect(result?.snapshot.reason).toBe("refund");
  });

  it("markPurchaseFraud flags the review tied to the purchase and recomputes reputation", async () => {
    mockPurchaseFindByIdAndUpdate.mockReturnValue(
      mockQuery({ _id: "pur-1", promptId: "p1", buyerWallet: BUYER_1 }),
    );
    mockReviewFindOne.mockReturnValue(mockQuery({ _id: "review-1" }));
    mockPromptFindById.mockReturnValue(mockQuery(prompt("p1", CREATOR_A)));
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery([]));

    const result = await markPurchaseFraud("pur-1");

    expect(mockReviewFlagCreate).toHaveBeenCalledWith(
      expect.objectContaining({ code: AbuseFlagCode.FRAUD_CONFIRMED }),
    );
    expect(result?.snapshot.reason).toBe("fraud_confirmed");
  });

  it("throws when the purchase does not exist", async () => {
    mockPurchaseFindByIdAndUpdate.mockReturnValue(mockQuery(null));
    await expect(markPurchaseFraud("missing")).rejects.toThrow(ReputationError);
  });
});

describe("appeals — reviewer/seller conflict-of-interest control", () => {
  it("files an appeal and marks the flag as appealed", async () => {
    const flagSave = jest.fn();
    mockReviewFlagFindById.mockResolvedValue({
      _id: "flag-1",
      reviewId: "review-1",
      status: "active",
      save: flagSave,
    });

    const appeal = await fileAppeal({ flagId: "flag-1", appellantWallet: BUYER_1, reason: "not a sockpuppet" });

    expect(appeal).toBeDefined();
    expect(flagSave).toHaveBeenCalled();
    expect(mockReviewAppealCreate).toHaveBeenCalledWith(
      expect.objectContaining({ appellantWallet: BUYER_1, status: "pending" }),
    );
  });

  it("rejects resolution attempts by the appellant themselves", async () => {
    mockReviewAppealFindById.mockResolvedValue({
      _id: "appeal-1",
      flagId: "flag-1",
      appellantWallet: BUYER_1,
      save: jest.fn(),
    });
    mockReviewFlagFindById.mockResolvedValue({
      _id: "flag-1",
      reviewerWallet: BUYER_1,
      sellerWallet: CREATOR_A,
      save: jest.fn(),
    });

    await expect(
      resolveAppeal({ appealId: "appeal-1", resolverWallet: BUYER_1, approve: true }),
    ).rejects.toThrow(/cannot resolve/i);
  });

  it("rejects resolution attempts by the affected seller", async () => {
    mockReviewAppealFindById.mockResolvedValue({
      _id: "appeal-1",
      flagId: "flag-1",
      appellantWallet: BUYER_1,
      save: jest.fn(),
    });
    mockReviewFlagFindById.mockResolvedValue({
      _id: "flag-1",
      reviewerWallet: BUYER_1,
      sellerWallet: CREATOR_A,
      save: jest.fn(),
    });

    await expect(
      resolveAppeal({ appealId: "appeal-1", resolverWallet: CREATOR_A, approve: true }),
    ).rejects.toThrow(/cannot resolve/i);
  });

  it("allows a neutral moderator to overturn a flag, restoring the review to eligibility", async () => {
    const appealSave = jest.fn();
    const flagSave = jest.fn();
    mockReviewAppealFindById.mockResolvedValue({
      _id: "appeal-1",
      flagId: "flag-1",
      appellantWallet: BUYER_1,
      save: appealSave,
    });
    mockReviewFlagFindById.mockResolvedValue({
      _id: "flag-1",
      reviewerWallet: BUYER_1,
      sellerWallet: CREATOR_A,
      status: "appealed",
      save: flagSave,
    });
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery([]));

    const result = await resolveAppeal({
      appealId: "appeal-1",
      resolverWallet: "gmoderator",
      approve: true,
    });

    expect(result.flag.status).toBe("overturned");
    expect(result.appeal.status).toBe("approved");
    expect(flagSave).toHaveBeenCalled();
    expect(result.snapshot.reason).toBe("appeal_resolved");
  });
});

describe("computeReputation — low sample & deterministic rebuild", () => {
  it("reports reduced confidence for low-volume creators instead of a misleading precise score", async () => {
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery([{ _id: "r1", rating: 5, createdAt: new Date() }]));

    const asOf = new Date("2026-01-01T00:00:00Z");
    const result = await computeReputation(CREATOR_A, { asOf });

    expect(result.sampleSize).toBe(1);
    expect(result.confidence).toBeLessThan(1);
    expect(result.explanationCodes).toContain("LOW_SAMPLE_UNCERTAIN");
  });

  it("is deterministic: rebuilding from the same inputs and asOf yields an identical hash and score", async () => {
    const reviews = [
      { _id: "r1", rating: 5, createdAt: new Date("2025-12-01T00:00:00Z") },
      { _id: "r2", rating: 3, createdAt: new Date("2025-12-15T00:00:00Z") },
    ];
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery(reviews));

    const asOf = new Date("2026-01-01T00:00:00Z");
    const first = await computeReputation(CREATOR_A, { asOf });
    const second = await computeReputation(CREATOR_A, { asOf });

    expect(second.inputsHash).toBe(first.inputsHash);
    expect(second.weightedScore).toBe(first.weightedScore);
    expect(second.rawAverage).toBe(first.rawAverage);
  });

  it("excludes reviews carrying an active or upheld fraud/abuse flag from the score", async () => {
    const reviews = [
      { _id: "r1", rating: 5, createdAt: new Date() },
      { _id: "r2", rating: 1, createdAt: new Date() },
    ];
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery(reviews));
    mockReviewFlagFind.mockReturnValue(mockQuery(["r2"]));

    const result = await computeReputation(CREATOR_A);

    expect(result.sampleSize).toBe(1);
    expect(result.excludedCount).toBe(1);
    expect(result.rawAverage).toBe(5);
    expect(result.explanationCodes).toContain("MODERATION_ADJUSTED");
  });
});

describe("recomputeReputationSnapshot — policy upgrade & versioning", () => {
  it("chains a new snapshot to the previous one without mutating it", async () => {
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery([{ _id: "r1", rating: 4, createdAt: new Date() }]));
    mockSnapshotFindOne.mockReturnValue(mockQuery({ _id: "snap-old", snapshotVersion: 3 }));

    const snapshot = await recomputeReputationSnapshot(CREATOR_A, "manual_rebuild");

    const createdWith = mockSnapshotCreate.mock.calls[0][0];
    expect(createdWith.snapshotVersion).toBe(4);
    expect(createdWith.previousSnapshotId).toBe("snap-old");
    expect(snapshot).toBeDefined();
  });

  it("recomputing under a bumped policy version records the new policyVersion on the snapshot", async () => {
    mockPromptFind.mockReturnValue(mockQuery([prompt("p1", CREATOR_A)]));
    mockReviewFind.mockReturnValue(mockQuery([{ _id: "r1", rating: 4, createdAt: new Date() }]));

    await recomputeReputationSnapshot(CREATOR_A, "policy_upgrade", { policyVersion: 1 });

    const createdWith = mockSnapshotCreate.mock.calls[0][0];
    expect(createdWith.policyVersion).toBe(1);
    expect(createdWith.reason).toBe("policy_upgrade");
  });
});

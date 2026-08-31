import { Router, Request, Response } from "express";
import FulfillmentRecord, {
  FulfillmentStatus,
} from "../models/FulfillmentRecord";

export const fulfillmentRouter = Router();

type ActorRole = "buyer" | "unlock-service" | "scheduler" | "admin";

type ActorInfo = {
  role: ActorRole;
  actor: string;
};

const readHeader = (req: Request, name: string): string | null => {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
};

const getBearerToken = (req: Request): string | null => {
  const auth = readHeader(req, "authorization") ?? readHeader(req, "Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token || null;
};

const normalizeWallet = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
};

const getWalletPrincipal = (req: Request): string => {
  return normalizeWallet(
    readHeader(req, "x-wallet-address") ??
      (req.body as Record<string, unknown> | undefined)?.walletAddress ??
      (req.body as Record<string, unknown> | undefined)?.buyerWallet ??
      (req.query as Record<string, unknown> | undefined)?.walletAddress ??
      (req.query as Record<string, unknown> | undefined)?.buyerWallet,
  );
};

const getConfiguredTokens = (role: ActorRole): string[] => {
  switch (role) {
    case "admin":
      return [process.env.ADMIN_ROTATION_TOKEN ?? "", process.env.ADMIN_API_KEY ?? ""].filter(Boolean);
    case "unlock-service":
      return [
        process.env.UNLOCK_SERVICE_TOKEN ?? "",
        process.env.UNLOCK_SERVICE_SECRET ?? "",
        process.env.UNLOCK_SERVICE_API_KEY ?? "",
      ].filter(Boolean);
    case "scheduler":
      return [
        process.env.SCHEDULER_TOKEN ?? "",
        process.env.SCHEDULER_SECRET ?? "",
        process.env.SCHEDULER_API_KEY ?? "",
      ].filter(Boolean);
    case "buyer":
      return [];
    default:
      return [];
  }
};

const requireActor = (req: Request, allowed: ActorRole[], requiredWallet?: string): ActorInfo | null => {
  const bearer = getBearerToken(req);
  if (bearer) {
    for (const role of allowed) {
      const tokenList = getConfiguredTokens(role);
      if (tokenList.some((candidate) => bearer === candidate.trim())) {
        return { role, actor: role };
      }
    }
  }

  if (allowed.includes("buyer")) {
    const wallet = getWalletPrincipal(req);
    if (!wallet) return null;
    if (requiredWallet && wallet !== requiredWallet) return null;
    return { role: "buyer", actor: wallet };
  }

  return null;
};

const getExpectedStatus = (req: Request): string | undefined => {
  const value = (req.body as Record<string, unknown> | undefined)?.expectedStatus ??
    (req.body as Record<string, unknown> | undefined)?.fromStatus ??
    (req.body as Record<string, unknown> | undefined)?.previousStatus;
  return typeof value === "string" ? value : undefined;
};

const isTerminalStatus = (status: FulfillmentStatus): boolean =>
  status === "refunded" || status === "rejected";

const isStateTransitionAllowed = (
  currentStatus: FulfillmentStatus,
  nextStatus: FulfillmentStatus,
): boolean => {
  if (currentStatus === nextStatus) return true;
  if (isTerminalStatus(currentStatus) && currentStatus !== nextStatus) return false;

  if (currentStatus === "pending") return nextStatus === "delivered" || nextStatus === "failed";
  if (currentStatus === "failed") return nextStatus === "refund_requested";
  if (currentStatus === "refund_requested") return nextStatus === "refunded" || nextStatus === "rejected";
  return false;
};

const addAuditEntry = (
  record: any,
  status: FulfillmentStatus,
  note: string,
  actor: string,
  role: ActorRole,
): void => {
  record.auditLog = Array.isArray(record.auditLog) ? record.auditLog : [];
  record.auditLog.push({
    status,
    note,
    at: new Date(),
    actor,
    actorRole: role,
  });
};

/**
 * GET /api/fulfillment/:promptId/:buyerWallet
 * Returns the fulfillment record for a specific purchase.
 */
fulfillmentRouter.get(
  "/:promptId/:buyerWallet",
  async (req: Request, res: Response) => {
    const { promptId, buyerWallet } = req.params;
    const normalizedBuyer = buyerWallet.toLowerCase();
    const walletFromRequest = getWalletPrincipal(req);
    if (walletFromRequest && walletFromRequest !== normalizedBuyer) {
      res.status(403).json({ error: "Buyer may only read their own fulfillment record" });
      return;
    }

    const actor = requireActor(req, ["buyer", "admin", "unlock-service", "scheduler"], normalizedBuyer);
    if (!actor) {
      res.status(401).json({ error: "Unauthorized fulfillment access" });
      return;
    }

    const record = await FulfillmentRecord.findOne({
      promptId,
      buyerWallet: normalizedBuyer,
    });
    if (!record) {
      res.status(404).json({ error: "Fulfillment record not found" });
      return;
    }
    res.json(record);
  },
);

/**
 * POST /api/fulfillment
 * Creates or updates the fulfillment record for a purchase.
 * Called by the unlock service when delivery is attempted.
 *
 * Body: { promptId, buyerWallet, txHash?, status, failureReason?, expectedStatus? }
 */
fulfillmentRouter.post("/", async (req: Request, res: Response) => {
  const {
    promptId,
    buyerWallet,
    txHash,
    status,
    failureReason,
  }: {
    promptId: string;
    buyerWallet: string;
    txHash?: string;
    status: FulfillmentStatus;
    failureReason?: string;
  } = req.body;

  if (!promptId || !buyerWallet || !status) {
    res.status(400).json({ error: "promptId, buyerWallet and status are required" });
    return;
  }

  const normalizedBuyer = buyerWallet.toLowerCase();
  const actor = requireActor(req, ["unlock-service"], normalizedBuyer);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized: unlock service credential required" });
    return;
  }

  if (["refund_requested", "refunded", "rejected"].includes(status)) {
    res.status(403).json({ error: "Only buyer or admin actions may move a fulfillment into a refund state" });
    return;
  }

  const expectedStatus = getExpectedStatus(req);
  const existing = await FulfillmentRecord.findOne({
    promptId,
    buyerWallet: normalizedBuyer,
  });

  if (existing && expectedStatus && existing.status !== expectedStatus) {
    res.status(409).json({
      error: "Fulfillment state changed before this update was applied",
      expectedStatus,
      currentStatus: existing.status,
    });
    return;
  }

  if (existing && !isStateTransitionAllowed(existing.status as FulfillmentStatus, status)) {
    res.status(409).json({
      error: "State transition is not allowed",
      currentStatus: existing.status,
      requestedStatus: status,
    });
    return;
  }

  const record = await FulfillmentRecord.findOneAndUpdate(
    { promptId, buyerWallet: normalizedBuyer },
    {
      $set: {
        txHash: txHash ?? "",
        status,
        failureReason: failureReason ?? "",
        ...(status !== "pending" ? { deliveryAttemptedAt: new Date() } : {}),
      },
      $push: {
        auditLog: {
          status,
          note: failureReason ?? "",
          at: new Date(),
          actor: actor.actor,
          actorRole: actor.role,
        },
      },
    },
    { upsert: true, new: true },
  );

  res.json(record);
});

/**
 * POST /api/fulfillment/:promptId/:buyerWallet/request-refund
 * The buyer requests a refund for a failed or timed-out delivery.
 *
 * Body: { reason, disputeTxHash?, expectedStatus? }
 */
fulfillmentRouter.post(
  "/:promptId/:buyerWallet/request-refund",
  async (req: Request, res: Response) => {
    const { promptId, buyerWallet } = req.params;
    const normalizedBuyer = buyerWallet.toLowerCase();
    const walletFromRequest = getWalletPrincipal(req);
    if (walletFromRequest && walletFromRequest !== normalizedBuyer) {
      res.status(403).json({ error: "Buyer may only request a refund for their own wallet" });
      return;
    }

    const actor = requireActor(req, ["buyer"], normalizedBuyer);
    if (!actor) {
      res.status(401).json({ error: "Unauthorized: wallet owner credential required" });
      return;
    }

    const { reason, disputeTxHash } = req.body as {
      reason: string;
      disputeTxHash?: string;
      expectedStatus?: string;
    };

    if (!reason) {
      res.status(400).json({ error: "reason is required" });
      return;
    }

    const record = await FulfillmentRecord.findOne({
      promptId,
      buyerWallet: normalizedBuyer,
    });

    if (!record) {
      res.status(404).json({ error: "Fulfillment record not found" });
      return;
    }

    if (record.status !== "failed" && record.status !== "pending") {
      res.status(409).json({
        error: "Purchase is not eligible for a refund",
        status: record.status,
      });
      return;
    }

    if (record.status === "refund_requested" || record.status === "refunded" || record.status === "rejected") {
      res.status(409).json({
        error: "Purchase is not eligible for a refund",
        status: record.status,
      });
      return;
    }

    if (record.status !== "pending" && record.status !== "failed") {
      res.status(409).json({
        error: "Purchase is not eligible for a refund",
        status: record.status,
      });
      return;
    }

    const expectedStatus = getExpectedStatus(req);
    if (expectedStatus && record.status !== expectedStatus) {
      res.status(409).json({
        error: "Fulfillment state changed before this refund request was applied",
        expectedStatus,
        currentStatus: record.status,
      });
      return;
    }

    if (!record.isRefundEligible()) {
      res.status(409).json({
        error: "Purchase is not eligible for a refund",
        status: record.status,
      });
      return;
    }

    record.status = "refund_requested";
    record.refundReason = reason;
    if (disputeTxHash) record.disputeTxHash = disputeTxHash;
    addAuditEntry(record, "refund_requested", reason, actor.actor, actor.role);
    await record.save();

    res.json(record);
  },
);

/**
 * POST /api/fulfillment/:promptId/:buyerWallet/resolve
 * Admin resolves a refund request (approve or reject).
 *
 * Body: { refund: boolean, resolutionTxHash?, expectedStatus? }
 */
fulfillmentRouter.post(
  "/:promptId/:buyerWallet/resolve",
  async (req: Request, res: Response) => {
    const { promptId, buyerWallet } = req.params;
    const normalizedBuyer = buyerWallet.toLowerCase();
    const actor = requireActor(req, ["admin"], normalizedBuyer);

    if (!actor) {
      res.status(401).json({ error: "Unauthorized: admin credential required" });
      return;
    }

    const { refund, resolutionTxHash } = req.body as {
      refund: boolean;
      resolutionTxHash?: string;
      expectedStatus?: string;
    };

    const record = await FulfillmentRecord.findOne({
      promptId,
      buyerWallet: normalizedBuyer,
    });

    if (!record) {
      res.status(404).json({ error: "Fulfillment record not found" });
      return;
    }

    const expectedStatus = getExpectedStatus(req);
    if (expectedStatus && record.status !== expectedStatus) {
      res.status(409).json({
        error: "Fulfillment state changed before this resolution was applied",
        expectedStatus,
        currentStatus: record.status,
      });
      return;
    }

    if (record.status !== "refund_requested") {
      res.status(409).json({
        error: "Record is not in refund_requested state",
        status: record.status,
      });
      return;
    }

    const newStatus: FulfillmentStatus = refund ? "refunded" : "rejected";
    record.status = newStatus;
    if (resolutionTxHash) record.resolutionTxHash = resolutionTxHash;
    addAuditEntry(record, newStatus, refund ? "Refund approved" : "Refund rejected", actor.actor, actor.role);
    await record.save();

    res.json(record);
  },
);

/**
 * GET /api/fulfillment/pending-refunds
 * Returns all records with status=refund_requested.
 * Intended for admin dashboards.
 */
fulfillmentRouter.get("/pending-refunds", async (req: Request, res: Response) => {
  const actor = requireActor(req, ["admin"]);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized: admin credential required" });
    return;
  }

  const records = await FulfillmentRecord.find({
    status: "refund_requested",
  }).sort({ updatedAt: -1 });
  res.json(records);
});

/**
 * POST /api/fulfillment/auto-refund-sweep
 * Marks all purchases that are still `pending` or `failed` after the
 * timeout window as `refund_requested`. Intended to be called by a
 * cron job or a scheduled task.
 */
fulfillmentRouter.post("/auto-refund-sweep", async (req: Request, res: Response) => {
  const actor = requireActor(req, ["scheduler", "admin"]);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized: scheduler or admin credential required" });
    return;
  }

  const timeoutMs = parseInt(
    process.env.FULFILLMENT_TIMEOUT_MS ?? "600000",
    10,
  );
  const cutoff = new Date(Date.now() - timeoutMs);

  const result = await FulfillmentRecord.updateMany(
    {
      status: { $in: ["pending", "failed"] },
      deliveryAttemptedAt: { $lte: cutoff },
    },
    {
      $set: { status: "refund_requested", refundReason: "Auto-refund: delivery timeout" },
      $push: {
        auditLog: {
          status: "refund_requested",
          note: "Auto-refund: delivery timeout exceeded",
          at: new Date(),
          actor: actor.actor,
          actorRole: actor.role,
        },
      },
    },
  );

  res.json({ swept: result.modifiedCount });
});

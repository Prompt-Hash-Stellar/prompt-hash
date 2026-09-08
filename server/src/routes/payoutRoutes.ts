import { Router, Request, Response } from "express";
import PayoutStatement from "../models/PayoutStatement";
import {
  generatePayoutStatement,
  exportStatementAsCsv,
  exportStatementAsJson,
  updateStatementStatus,
  DEFAULT_PLATFORM_FEE_BPS,
} from "../services/payoutStatementService";

export const payoutRouter = Router();

/**
 * GET /api/payouts/statements/:walletAddress
 * Lists saved payout statements for a creator or previews on-the-fly reconciliation.
 */
payoutRouter.get(
  "/statements/:walletAddress",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { walletAddress } = req.params;
      const { periodStart, periodEnd, preview, limit = "20", page = "1" } = req.query;

      const normalizedWallet = walletAddress.trim().toLowerCase();

      // On-the-fly preview calculation without requiring prior DB record
      if (preview === "true" && periodStart && periodEnd) {
        const statement = await generatePayoutStatement({
          creatorWallet: normalizedWallet,
          periodStart: String(periodStart),
          periodEnd: String(periodEnd),
          persist: false,
        });
        res.status(200).json({ statement });
        return;
      }

      const query: any = { creatorWallet: normalizedWallet };
      if (periodStart) {
        query.periodStart = { $gte: new Date(String(periodStart)) };
      }
      if (periodEnd) {
        query.periodEnd = { $lte: new Date(String(periodEnd)) };
      }

      const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
      const skip = (pageNum - 1) * limitNum;

      const [statements, total] = await Promise.all([
        PayoutStatement.find(query)
          .sort({ periodStart: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        PayoutStatement.countDocuments(query),
      ]);

      res.status(200).json({
        statements,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    } catch (err: any) {
      console.error("Failed to list payout statements:", err);
      res.status(500).json({ error: err.message || "Failed to retrieve payout statements." });
    }
  }
);

/**
 * GET /api/payouts/statements/:walletAddress/:statementId
 * Retrieves an individual payout statement with line items.
 */
payoutRouter.get(
  "/statements/:walletAddress/:statementId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { walletAddress, statementId } = req.params;
      const normalizedWallet = walletAddress.trim().toLowerCase();

      const statement = await PayoutStatement.findOne({
        statementId,
        creatorWallet: normalizedWallet,
      }).lean();

      if (!statement) {
        res.status(404).json({ error: "Payout statement not found." });
        return;
      }

      res.status(200).json({ statement });
    } catch (err: any) {
      console.error("Failed to get payout statement:", err);
      res.status(500).json({ error: err.message || "Failed to fetch statement." });
    }
  }
);

/**
 * GET /api/payouts/statements/:walletAddress/:statementId/export
 * Exports a payout statement as RFC-4180 CSV or structured JSON.
 */
payoutRouter.get(
  "/statements/:walletAddress/:statementId/export",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { walletAddress, statementId } = req.params;
      const { format = "csv" } = req.query;
      const normalizedWallet = walletAddress.trim().toLowerCase();

      const statement = await PayoutStatement.findOne({
        statementId,
        creatorWallet: normalizedWallet,
      });

      if (!statement) {
        res.status(404).json({ error: "Payout statement not found." });
        return;
      }

      if (format === "json") {
        const jsonData = exportStatementAsJson(statement);
        res.setHeader("Content-Type", "application/json");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${statement.statementId}.json"`
        );
        res.status(200).send(JSON.stringify(jsonData, null, 2));
        return;
      }

      // Default to RFC-4180 CSV
      const csvData = exportStatementAsCsv(statement);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${statement.statementId}.csv"`
      );
      res.status(200).send(csvData);
    } catch (err: any) {
      console.error("Failed to export payout statement:", err);
      res.status(500).json({ error: err.message || "Failed to export statement." });
    }
  }
);

/**
 * POST /api/payouts/statements/generate
 * Generates and stores a new payout statement for a given creator and period.
 */
payoutRouter.post(
  "/statements/generate",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { creatorWallet, periodStart, periodEnd, platformFeeBps } = req.body;

      if (!creatorWallet || !periodStart || !periodEnd) {
        res.status(400).json({
          error: "creatorWallet, periodStart, and periodEnd are required.",
        });
        return;
      }

      const statement = await generatePayoutStatement({
        creatorWallet: String(creatorWallet),
        periodStart: String(periodStart),
        periodEnd: String(periodEnd),
        platformFeeBps:
          typeof platformFeeBps === "number" ? platformFeeBps : DEFAULT_PLATFORM_FEE_BPS,
        persist: true,
      });

      res.status(201).json({ statement });
    } catch (err: any) {
      console.error("Failed to generate payout statement:", err);
      res.status(400).json({ error: err.message || "Failed to generate payout statement." });
    }
  }
);

/**
 * PATCH /api/payouts/statements/:statementId/status
 * Updates statement settlement status with payout transaction hash or failure reason.
 */
payoutRouter.patch(
  "/statements/:statementId/status",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { statementId } = req.params;
      const { status, payoutTxHash, failureReason, settledAt } = req.body;

      if (!status || !["pending", "settled", "failed"].includes(status)) {
        res.status(400).json({
          error: "Invalid status. Must be 'pending', 'settled', or 'failed'.",
        });
        return;
      }

      const updated = await updateStatementStatus(statementId, {
        status,
        payoutTxHash,
        failureReason,
        settledAt: settledAt ? new Date(settledAt) : undefined,
      });

      if (!updated) {
        res.status(404).json({ error: "Statement not found." });
        return;
      }

      res.status(200).json({ statement: updated });
    } catch (err: any) {
      console.error("Failed to update statement status:", err);
      res.status(500).json({ error: err.message || "Failed to update statement status." });
    }
  }
);

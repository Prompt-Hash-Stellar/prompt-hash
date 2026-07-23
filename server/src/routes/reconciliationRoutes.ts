import { Router, Request, Response } from "express";
import ReconciliationReport from "../models/ReconciliationReport";
import { runReconciliation, executeRepair } from "../services/reconciliationService";

export const reconciliationRouter = Router();

/**
 * POST /api/reconciliation/run
 * Initiates a settlement reconciliation scan across on-chain events, DB purchases, and webhooks.
 */
reconciliationRouter.post("/run", async (req: Request, res: Response) => {
  try {
    const { isDryRun = true, createdBy = "admin" } = req.body || {};
    const report = await runReconciliation({ isDryRun, createdBy });
    res.status(201).json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/reconciliation/reports
 * Lists all generated reconciliation reports.
 */
reconciliationRouter.get("/reports", async (_req: Request, res: Response) => {
  try {
    const reports = await ReconciliationReport.find({}).sort({ createdAt: -1 }).lean();
    res.json({ reports });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/reconciliation/reports/:reportId
 * Fetches a single reconciliation report by ID.
 */
reconciliationRouter.get("/reports/:reportId", async (req: Request, res: Response) => {
  try {
    const { reportId } = req.params;
    const report = await ReconciliationReport.findOne({ reportId }).lean();
    if (!report) {
      res.status(404).json({ error: "Reconciliation report not found" });
      return;
    }
    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/reconciliation/repair/:reportId
 * Approves and executes repairs for a reconciliation report (maker-checker pattern).
 */
reconciliationRouter.post("/repair/:reportId", async (req: Request, res: Response) => {
  try {
    const { reportId } = req.params;
    const { approvedBy = "admin" } = req.body || {};
    const result = await executeRepair(reportId, approvedBy);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

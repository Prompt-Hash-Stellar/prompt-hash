import { Router } from "express";
import {
  createAppeal,
  getAppeal,
  listAppeals,
  updateAppealStatus,
  getAppealStats,
} from "../controllers/appealController";

const router = Router();

router.post("/appeals", createAppeal);
router.get("/appeals", listAppeals);
router.get("/appeals/stats", getAppealStats);
router.get("/appeals/:id", getAppeal);
router.patch("/appeals/:id", updateAppealStatus);

export default router;

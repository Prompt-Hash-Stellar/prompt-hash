import "dotenv/config";
import * as Sentry from "@sentry/node";
import express, { type Express } from "express";
import { TestPromptProxy } from "./controllers/controllers";
import { proxyrouter } from "./routes/proxyRoutes";
import { promptRouter } from "./routes/promptRoutes";
import { userRouter } from "./routes/userRoutes";
import { chatRouter } from "./routes/chatRoutes";
import { webhookRouter } from "./routes/webhookRoutes";
import { versioningRouter } from "./routes/versioningRoutes";
import { governanceRouter } from "./routes/governanceRoutes"; // Issue #113
import searchRouter from "./routes/searchRoutes";
import { fulfillmentRouter } from "./routes/fulfillmentRoutes";
import { reconciliationRouter } from "./routes/reconciliationRoutes";
import { reviewRouter } from "./routes/reviewRoutes";
import { getBackupHealth } from "./services/backupService";
import { IndexerState } from "./models/IndexerState";
import {
  globalLimiter,
  authLimiter,
  strictLimiter,
  chatLimiter,
} from "./middleware/rateLimiter";
import { correlationIdMiddleware, requestLogger } from "./middleware/correlationId";
// import { startIndexer } from "./services/indexerService"; // TODO: Update path when ready

// ── Sentry backend monitoring (#332) ─────────────────────────────────────────
// Set SENTRY_DSN in the server .env to enable exception capture.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  });
}

const app = express();

const port = 5000;

app.use(correlationIdMiddleware);
app.use(requestLogger);

// Sentry error handler should be registered after routes (#332).
app.use(express.json());

// ── Rate limiting ────────────────────────────────────────────────────────────
// Global rate limit: 100 requests per 15 minutes per IP.
app.use(globalLimiter);

app.use("/api/improve-proxy", strictLimiter, proxyrouter);

app.use("/api/prompts", promptRouter);

app.use("/api/user", authLimiter, userRouter);

app.use("/api/chat", chatLimiter, chatRouter);
app.use("/api/webhooks", strictLimiter, webhookRouter);
app.use("/api/versions", versioningRouter);
app.use("/api/governance", authLimiter, governanceRouter); // Issue #113
app.use("/api/search", searchRouter);
app.use("/api/fulfillment", strictLimiter, fulfillmentRouter);
app.use("/api/reviews", reviewRouter);

app.post("/api/test-prompt", strictLimiter, TestPromptProxy);

app.get("/health", async (req, res) => {
  const [state, backupHealth] = await Promise.all([
    IndexerState.findOne({ key: "prompt_hash_contract" }),
    getBackupHealth(),
  ]);
  res.json({
    status: "ok",
    indexer: {
      lastProcessedLedger: state?.lastIndexedLedger || 0,
      sourceCheckpoint: state?.sourceCheckpoint || state?.lastIndexedLedger || 0,
      rawEventCheckpoint: state?.rawEventCheckpoint || state?.lastIndexedLedger || 0,
      projectionCheckpoint: state?.projectionCheckpoint || 0,
      quarantinedFailures: state?.quarantinedFailures || 0,
      lease: state?.leaseOwner
        ? {
            ownerId: state.leaseOwner,
            fencingToken: state.leaseFencingToken || 0,
            expiresAt: state.leaseExpiresAt,
          }
        : null,
      timestamp: new Date(),
    },
    backup: backupHealth,
  });
});

// Sentry error handler must be registered after all routes (#332).
// expressErrorHandler is available in @sentry/node v7; v8+ uses setupExpressErrorHandler.
if (process.env.SENTRY_DSN) {
  if (typeof (Sentry as Record<string, unknown>).setupExpressErrorHandler === "function") {
    (Sentry as unknown as { setupExpressErrorHandler: (app: Express) => void }).setupExpressErrorHandler(app);
  } else if (typeof (Sentry as Record<string, unknown>).expressErrorHandler === "function") {
    app.use((Sentry as unknown as { expressErrorHandler: () => import("express").ErrorRequestHandler }).expressErrorHandler());
  }
}

app.listen(port, () => {
  console.log(`Listening on port ${port}`);

  // STARTS THE INDEXER HERE
  // startIndexer().catch((err: any) => {
  //   console.error("Failed to start Soroban Indexer:", err);
  // });

  // Backups are scheduled only by backup.crontab. runBackup itself also takes a
  // MongoDB lease, so overlapping cron/container invocations cannot run twice.
});

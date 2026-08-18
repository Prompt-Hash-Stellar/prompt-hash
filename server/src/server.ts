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
import { corsMiddleware, securityHeaders, configureTrustedProxy } from "./middleware/security";
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

// ── Trusted proxy configuration ──────────────────────────────────────────────
// Must be set before anything reads req.ip (rate limiters, CORS, logging) so
// client IPs are derived from only the configured number of trusted
// X-Forwarded-For hops instead of a spoofable header. See
// middleware/security.ts and docs/security-model.md.
configureTrustedProxy(app);

// ── Defensive headers & CORS ─────────────────────────────────────────────────
// Registered before body parsing / routes so every response - including
// rejected/oversized requests - carries the hardened headers, and so
// disallowed origins never reach the API handlers.
app.use(securityHeaders());
app.use(corsMiddleware());

// Sentry error handler should be registered after routes (#332).
// Bounded JSON body limits per route class: a conservative default for
// most JSON APIs, with a larger budget for the routes that carry prompt
// content (create/update/version), which can legitimately be large. Each
// route class gets its own express.json() instance (rather than one
// global parser plus per-route overrides) because body-parser can only
// consume the request stream once - a second express.json() on the same
// request is a no-op, so the limit that matters is whichever one runs
// first per route.
const promptContentJsonLimit = express.json({ limit: "2mb" });
const defaultJsonLimit = express.json({ limit: "100kb" });

// ── Rate limiting ────────────────────────────────────────────────────────────
// Global rate limit: 100 requests per 15 minutes per IP.
app.use(globalLimiter);

app.use("/api/improve-proxy", defaultJsonLimit, strictLimiter, proxyrouter);

app.use("/api/prompts", promptContentJsonLimit, promptRouter);

app.use("/api/user", defaultJsonLimit, authLimiter, userRouter);

app.use("/api/chat", defaultJsonLimit, chatLimiter, chatRouter);
app.use("/api/webhooks", defaultJsonLimit, strictLimiter, webhookRouter);
app.use("/api/versions", promptContentJsonLimit, versioningRouter);
app.use("/api/governance", defaultJsonLimit, authLimiter, governanceRouter); // Issue #113
app.use("/api/search", defaultJsonLimit, searchRouter);
app.use("/api/fulfillment", defaultJsonLimit, strictLimiter, fulfillmentRouter);
app.use("/api/reviews", defaultJsonLimit, reviewRouter);

app.post("/api/test-prompt", defaultJsonLimit, strictLimiter, TestPromptProxy);

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

// Final JSON error handler: catches CORS rejections (disallowed origin),
// oversized-body errors from express.json(), and anything else forwarded
// via next(err), so clients always get a clean JSON error instead of
// Express's default HTML error page.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) {
    return;
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  if (typeof err?.message === "string" && err.message.includes("not allowed by CORS policy")) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  console.error("Unhandled request error:", err?.message ?? err);
  return res.status(500).json({ error: "Internal server error" });
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);

  // STARTS THE INDEXER HERE
  // startIndexer().catch((err: any) => {
  //   console.error("Failed to start Soroban Indexer:", err);
  // });

  // Backups are scheduled only by backup.crontab. runBackup itself also takes a
  // MongoDB lease, so overlapping cron/container invocations cannot run twice.
});

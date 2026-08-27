import { IndexerState } from "../models/IndexerState";
import { getBackupHealth, type BackupHealth } from "./backupService";

// ── Readiness thresholds ─────────────────────────────────────────────────────
// How stale the indexer checkpoint may be, how large the quarantine backlog
// may grow, and how long a dependency check is allowed to take before it is
// treated as failed. All are overridable via env so operators can tune them
// per environment without a code change (see server/.env.example).
const DEFAULT_INDEXER_STALENESS_MINUTES = 15;
const DEFAULT_INDEXER_QUARANTINE_THRESHOLD = 25;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 3000;

export type ReadinessReason =
  | "indexer_state_missing"
  | "indexer_checkpoint_stale"
  | "indexer_quarantine_backlog"
  | "indexer_lease_expired"
  | "indexer_check_timeout"
  | "backup_unhealthy"
  | "backup_check_timeout";

export interface ReadinessResult {
  status: "ready" | "not_ready";
  checkedAt: string;
  reasons: ReadinessReason[];
  indexer: {
    lastProcessedLedger: number;
    sourceCheckpoint: number;
    rawEventCheckpoint: number;
    projectionCheckpoint: number;
    quarantinedFailures: number;
    lease: { ownerId: string; fencingToken: number; expiresAt: Date | null } | null;
    lastUpdatedAt: string | null;
  };
  backup: BackupHealth;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Computes API readiness from the indexer checkpoint/quarantine/lease state
 * and backup health, instead of the previous hard-coded "ok". Every
 * dependency check is time-bounded so a slow/unavailable dependency fails
 * closed (not ready) rather than hanging the response. Reason codes are
 * redacted (no raw error messages/stack traces) and every response carries
 * the measurement timestamp used to evaluate it.
 */
export async function computeReadiness(now: Date = new Date()): Promise<ReadinessResult> {
  const timeoutMs = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS);
  const stalenessMinutes = Number(
    process.env.INDEXER_STALENESS_MINUTES ?? DEFAULT_INDEXER_STALENESS_MINUTES,
  );
  const quarantineThreshold = Number(
    process.env.INDEXER_QUARANTINE_THRESHOLD ?? DEFAULT_INDEXER_QUARANTINE_THRESHOLD,
  );

  const reasons: ReadinessReason[] = [];

  let state: any = null;
  let indexerCheckFailed = false;
  try {
    state = await withTimeout(
      IndexerState.findOne({ key: "prompt_hash_contract" }) as unknown as Promise<any>,
      timeoutMs,
    );
  } catch {
    indexerCheckFailed = true;
    reasons.push("indexer_check_timeout");
  }

  let backupHealth: BackupHealth;
  try {
    backupHealth = await withTimeout(getBackupHealth(), timeoutMs);
  } catch {
    reasons.push("backup_check_timeout");
    backupHealth = { lastRun: null, lastStatus: "never", ageHours: null, healthy: false };
  }

  if (!indexerCheckFailed) {
    if (!state) {
      reasons.push("indexer_state_missing");
    } else {
      const lastUpdatedAt: Date | undefined = state.updatedAt;
      if (lastUpdatedAt) {
        const ageMinutes = (now.getTime() - new Date(lastUpdatedAt).getTime()) / 60_000;
        if (ageMinutes > stalenessMinutes) reasons.push("indexer_checkpoint_stale");
      }
      if ((state.quarantinedFailures || 0) > quarantineThreshold) {
        reasons.push("indexer_quarantine_backlog");
      }
      if (
        state.leaseOwner &&
        state.leaseExpiresAt &&
        new Date(state.leaseExpiresAt).getTime() < now.getTime()
      ) {
        reasons.push("indexer_lease_expired");
      }
    }
  }

  if (!backupHealth.healthy) {
    reasons.push("backup_unhealthy");
  }

  return {
    status: reasons.length === 0 ? "ready" : "not_ready",
    checkedAt: now.toISOString(),
    reasons,
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
      lastUpdatedAt: state?.updatedAt ? new Date(state.updatedAt).toISOString() : null,
    },
    backup: backupHealth,
  };
}

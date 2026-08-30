jest.mock("../models/IndexerState", () => ({
  IndexerState: { findOne: jest.fn() },
}));
jest.mock("./backupService", () => ({
  getBackupHealth: jest.fn(),
}));

import { IndexerState } from "../models/IndexerState";
import { getBackupHealth } from "./backupService";
import { computeReadiness } from "./healthService";

const findOne = IndexerState.findOne as jest.Mock;
const backupHealth = getBackupHealth as jest.Mock;

const healthyBackup = { lastRun: new Date("2026-01-01T00:00:00.000Z"), lastStatus: "success" as const, ageHours: 1, healthy: true };
const now = new Date("2026-01-01T12:00:00.000Z");

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INDEXER_STALENESS_MINUTES = "15";
  process.env.INDEXER_QUARANTINE_THRESHOLD = "25";
  process.env.HEALTH_CHECK_TIMEOUT_MS = "50";
  backupHealth.mockResolvedValue(healthyBackup);
});

describe("computeReadiness", () => {
  test("reports not ready when no indexer state exists yet", async () => {
    findOne.mockResolvedValue(null);
    const result = await computeReadiness(now);
    expect(result.status).toBe("not_ready");
    expect(result.reasons).toContain("indexer_state_missing");
  });

  test("reports not ready on a stale checkpoint", async () => {
    findOne.mockResolvedValue({
      lastIndexedLedger: 100,
      quarantinedFailures: 0,
      updatedAt: new Date(now.getTime() - 30 * 60_000),
    });
    const result = await computeReadiness(now);
    expect(result.status).toBe("not_ready");
    expect(result.reasons).toContain("indexer_checkpoint_stale");
  });

  test("reports not ready when the indexer lease is expired", async () => {
    findOne.mockResolvedValue({
      lastIndexedLedger: 100,
      quarantinedFailures: 0,
      updatedAt: now,
      leaseOwner: "worker-a",
      leaseFencingToken: 4,
      leaseExpiresAt: new Date(now.getTime() - 60_000),
    });
    const result = await computeReadiness(now);
    expect(result.status).toBe("not_ready");
    expect(result.reasons).toContain("indexer_lease_expired");
  });

  test("reports not ready when the quarantine backlog exceeds the threshold", async () => {
    findOne.mockResolvedValue({
      lastIndexedLedger: 100,
      quarantinedFailures: 26,
      updatedAt: now,
    });
    const result = await computeReadiness(now);
    expect(result.status).toBe("not_ready");
    expect(result.reasons).toContain("indexer_quarantine_backlog");
  });

  test("reports not ready when backups are unhealthy", async () => {
    findOne.mockResolvedValue({ lastIndexedLedger: 100, quarantinedFailures: 0, updatedAt: now });
    backupHealth.mockResolvedValue({ lastRun: null, lastStatus: "failure", ageHours: 40, healthy: false });
    const result = await computeReadiness(now);
    expect(result.status).toBe("not_ready");
    expect(result.reasons).toContain("backup_unhealthy");
  });

  test("reports not ready when a dependency check times out", async () => {
    findOne.mockImplementation(() => new Promise(() => {})); // never resolves
    const result = await computeReadiness(now);
    expect(result.status).toBe("not_ready");
    expect(result.reasons).toContain("indexer_check_timeout");
  });

  test("recovers to ready once checkpoints, lease, quarantine, and backups are all healthy", async () => {
    findOne.mockResolvedValue({
      lastIndexedLedger: 100,
      quarantinedFailures: 0,
      updatedAt: now,
      leaseOwner: "worker-a",
      leaseFencingToken: 4,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    const result = await computeReadiness(now);
    expect(result.status).toBe("ready");
    expect(result.reasons).toEqual([]);
    expect(result.checkedAt).toBe(now.toISOString());
  });
});

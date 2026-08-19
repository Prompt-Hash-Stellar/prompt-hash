import { COLLECTION_INVENTORY, acquireBackupLease, BackupLease, signManifest, verifyManifest } from "./backupService";

describe("backup reliability", () => {
  beforeEach(() => { process.env.BACKUP_MANIFEST_SIGNING_KEY = "test-only-signing-key"; });

  test("inventory covers every recovery-critical model collection", () => {
    expect(COLLECTION_INVENTORY.included).toEqual(expect.arrayContaining([
      "prompts", "purchases", "promptversions", "indexerstates", "auditlogs", "users", "reviews",
      "fulfillmentrecords", "reconciliationreports", "webhooksubscriptions", "webhookdeliverylogs", "reports", "votes",
    ]));
    expect(Object.values(COLLECTION_INVENTORY.excluded).every(reason => reason.length > 20)).toBe(true);
  });

  test("manifest corruption invalidates its signature", () => {
    const manifest = signManifest({ formatVersion: 2, backupId: "id", database: "db",
      startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z",
      snapshotPolicy: "mongodb-snapshot-transaction", collections: [], exclusions: COLLECTION_INVENTORY.excluded });
    expect(verifyManifest(manifest)).toBe(true);
    manifest.backupId = "corrupted";
    expect(verifyManifest(manifest)).toBe(false);
  });

  test("scheduler contention does not acquire another owner's lease", async () => {
    const spy = jest.spyOn(BackupLease, "findOneAndUpdate").mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: 11000 }));
    await expect(acquireBackupLease("second-runner")).resolves.toBe(false);
    spy.mockRestore();
  });
});

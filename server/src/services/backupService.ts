/** Streaming, point-in-time MongoDB backups (issue #153). */
import mongoose, { type ClientSession } from "mongoose";
import { createGzip } from "zlib";
import { Transform, PassThrough, type Readable } from "stream";
import { pipeline } from "stream/promises";
import { createHash, createHmac, randomUUID } from "crypto";
import { timingSafeEqual } from "crypto";
import { EJSON } from "bson";

export const BACKUP_FORMAT_VERSION = 2;

/**
 * Recovery inventory. Add every new source-of-truth collection here in the same
 * change that introduces it. Exclusions must include an operator-readable reason.
 */
export const COLLECTION_INVENTORY = {
  included: [
    "prompts", "purchases", "promptversions", "indexerstates", "auditlogs",
    "users", "reviews", "fulfillmentrecords", "reconciliationreports",
    "webhooksubscriptions", "webhookdeliverylogs", "reports", "votes",
  ],
  excluded: {
    promptsearchindexes: "Derived search projection; rebuilt from prompts after restore.",
    backupruns: "Operational backup history; manifests in object storage are authoritative.",
    backupleases: "Ephemeral scheduler coordination state; restoring it can suppress a backup.",
  },
} as const;

export interface CollectionManifest {
  name: string;
  key: string;
  documents: number;
  compressedBytes: number;
  sha256: string;
}

export interface BackupManifest {
  formatVersion: number;
  backupId: string;
  database: string;
  startedAt: string;
  completedAt: string;
  snapshotPolicy: "mongodb-snapshot-transaction";
  collections: CollectionManifest[];
  exclusions: typeof COLLECTION_INVENTORY.excluded;
  signature: { algorithm: "hmac-sha256"; value: string };
}

const backupRunSchema = new mongoose.Schema({
  backupId: String,
  status: { type: String, enum: ["success", "failure"], required: true, index: true },
  manifestKey: String,
  s3Keys: [String],
  totalDocuments: { type: Number, default: 0 },
  errorMessage: { type: String, default: null },
  durationMs: { type: Number, default: null },
  restoreVerifiedAt: { type: Date, default: null },
}, { timestamps: true });

const backupLeaseSchema = new mongoose.Schema({
  _id: String,
  owner: String,
  expiresAt: Date,
}, { versionKey: false });

export const BackupRun = mongoose.models.BackupRun || mongoose.model("BackupRun", backupRunSchema);
export const BackupLease = mongoose.models.BackupLease || mongoose.model("BackupLease", backupLeaseSchema);

async function s3Send(commandName: "PutObjectCommand" | "GetObjectCommand", input: Record<string, unknown>) {
  const sdk = await import("@aws-sdk/client-s3" as string) as any;
  const client = new sdk.S3Client({ region: process.env.BACKUP_S3_REGION ?? "us-east-1" });
  return client.send(new sdk[commandName](input));
}

export async function putObject(key: string, body: Buffer | Readable, contentType: string): Promise<void> {
  const bucket = process.env.BACKUP_S3_BUCKET;
  if (!bucket) throw new Error("BACKUP_S3_BUCKET is not configured");
  if (!Buffer.isBuffer(body)) {
    const sdk = await import("@aws-sdk/client-s3" as string) as any;
    const storage = await import("@aws-sdk/lib-storage" as string) as any;
    const client = new sdk.S3Client({ region: process.env.BACKUP_S3_REGION ?? "us-east-1" });
    await new storage.Upload({ client, params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType },
      queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false }).done();
    return;
  }
  await s3Send("PutObjectCommand", { Bucket: bucket, Key: key, Body: body, ContentType: contentType });
}

function signingKey(): string {
  const key = process.env.BACKUP_MANIFEST_SIGNING_KEY;
  if (!key) throw new Error("BACKUP_MANIFEST_SIGNING_KEY is required");
  return key;
}

export function signManifest(unsigned: Omit<BackupManifest, "signature">): BackupManifest {
  const value = createHmac("sha256", signingKey()).update(JSON.stringify(unsigned)).digest("hex");
  return { ...unsigned, signature: { algorithm: "hmac-sha256", value } };
}

export function verifyManifest(manifest: BackupManifest): boolean {
  const { signature, ...unsigned } = manifest;
  const expected = createHmac("sha256", signingKey()).update(JSON.stringify(unsigned)).digest("hex");
  return signature.algorithm === "hmac-sha256" &&
    Buffer.from(signature.value, "hex").length === Buffer.from(expected, "hex").length &&
    timingSafeEqual(Buffer.from(signature.value, "hex"), Buffer.from(expected, "hex"));
}

export async function acquireBackupLease(owner: string, leaseMs = 4 * 60 * 60 * 1000): Promise<boolean> {
  const now = new Date();
  try {
    const lease = await BackupLease.findOneAndUpdate(
      { _id: "scheduled-backup", $or: [{ expiresAt: { $lte: now } }, { owner }] },
      { $set: { owner, expiresAt: new Date(now.getTime() + leaseMs) } },
      { upsert: true, new: true },
    );
    return lease?.owner === owner;
  } catch (error: any) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

export async function releaseBackupLease(owner: string): Promise<void> {
  await BackupLease.deleteOne({ _id: "scheduled-backup", owner });
}

async function exportCollection(name: string, key: string, session: ClientSession): Promise<CollectionManifest> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB not connected");
  let documents = 0;
  let compressedBytes = 0;
  const hash = createHash("sha256");
  const serializer = new Transform({
    writableObjectMode: true,
    transform(doc, _encoding, callback) {
      documents++;
      // Canonical Extended JSON preserves ObjectId, Date, Decimal128 and binary
      // values across a restore; ordinary JSON silently changes their types.
      callback(null, `${EJSON.stringify(doc, { relaxed: false })}\n`);
    },
  });
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const uploadBody = new PassThrough({ highWaterMark: 1024 * 1024 });
  const cursor = db.collection(name).find({}, { session, batchSize: 500 }).stream();
  await Promise.all([
    putObject(key, uploadBody, "application/gzip"),
    pipeline(cursor, serializer, createGzip({ level: 6 }), meter, uploadBody),
  ]);
  return { name, key, documents, compressedBytes, sha256: hash.digest("hex") };
}

export async function runBackup(options: { owner?: string; skipLease?: boolean } = {}): Promise<BackupManifest | null> {
  const started = Date.now();
  const owner = options.owner ?? `${process.pid}-${randomUUID()}`;
  if (!options.skipLease && !await acquireBackupLease(owner)) {
    console.log("[backup] Another scheduler owns the backup lease; skipping");
    return null;
  }
  const backupId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const prefix = process.env.BACKUP_S3_PREFIX ?? "backups";
  const session = await mongoose.startSession();
  const collections: CollectionManifest[] = [];
  try {
    // Snapshot transactions require a replica set/sharded cluster. This deliberately
    // fails on standalone MongoDB rather than producing a fuzzy recovery point.
    session.startTransaction({ readConcern: { level: "snapshot" } });
    for (const name of COLLECTION_INVENTORY.included) {
      collections.push(await exportCollection(name, `${prefix}/${backupId}/${name}.ndjson.gz`, session));
    }
    await session.commitTransaction();
    const unsigned = {
      formatVersion: BACKUP_FORMAT_VERSION,
      backupId,
      database: mongoose.connection.name,
      startedAt: new Date(started).toISOString(),
      completedAt: new Date().toISOString(),
      snapshotPolicy: "mongodb-snapshot-transaction" as const,
      collections,
      exclusions: COLLECTION_INVENTORY.excluded,
    };
    const manifest = signManifest(unsigned);
    const manifestKey = `${prefix}/${backupId}/manifest.v${BACKUP_FORMAT_VERSION}.json`;
    await putObject(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), "application/json");
    // Published last: consumers never discover a partial backup.
    await putObject(`${prefix}/latest.json`, Buffer.from(JSON.stringify({ manifestKey })), "application/json");
    await BackupRun.create({ backupId, status: "success", manifestKey, s3Keys: collections.map(c => c.key),
      totalDocuments: collections.reduce((n, c) => n + c.documents, 0), durationMs: Date.now() - started });
    return manifest;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    await BackupRun.create({ backupId, status: "failure", s3Keys: collections.map(c => c.key),
      totalDocuments: collections.reduce((n, c) => n + c.documents, 0), errorMessage: message,
      durationMs: Date.now() - started }).catch(() => undefined);
    await alertOnFailure(message);
    throw error;
  } finally {
    await session.endSession();
    if (!options.skipLease) await releaseBackupLease(owner).catch(() => undefined);
  }
}

async function alertOnFailure(message: string): Promise<void> {
  if (!process.env.BACKUP_ALERT_WEBHOOK) return;
  await fetch(process.env.BACKUP_ALERT_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `[PromptHash] Backup FAILED: ${message}`, timestamp: new Date().toISOString() }) })
    .catch(() => console.error("[backup] Failed to send failure alert"));
}

export interface BackupHealth { lastRun: Date | null; lastStatus: "success" | "failure" | "never"; ageHours: number | null; healthy: boolean }
export async function getBackupHealth(): Promise<BackupHealth> {
  const last: any = await BackupRun.findOne().sort({ createdAt: -1 }).lean();
  if (!last) return { lastRun: null, lastStatus: "never", ageHours: null, healthy: false };
  const ageHours = (Date.now() - new Date(last.createdAt).getTime()) / 3_600_000;
  const rpoHours = Number(process.env.BACKUP_RPO_HOURS ?? 26);
  return { lastRun: last.createdAt, lastStatus: last.status, ageHours: Math.round(ageHours * 10) / 10,
    healthy: last.status === "success" && ageHours < rpoHours };
}

/** Automated isolated restore drill for the latest published backup. */
import mongoose from "mongoose";
import { createHash, randomUUID } from "crypto";
import { createGunzip } from "zlib";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { EJSON } from "bson";
import { BACKUP_FORMAT_VERSION, BackupRun, type BackupManifest, verifyManifest } from "./backupService";

async function getObject(key: string): Promise<any> {
  const sdk = await import("@aws-sdk/client-s3" as string) as any;
  const bucket = process.env.BACKUP_S3_BUCKET;
  if (!bucket) throw new Error("BACKUP_S3_BUCKET is not configured");
  const client = new sdk.S3Client({ region: process.env.BACKUP_S3_REGION ?? "us-east-1" });
  const result = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`Object ${key} has no body`);
  return result.Body;
}

async function readSmallJson<T>(key: string): Promise<T> {
  const body = await getObject(key);
  const bytes = typeof body.transformToByteArray === "function"
    ? await body.transformToByteArray()
    : await new Response(body as any).arrayBuffer();
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
}

export interface RestoreDrillResult {
  backupId: string;
  restoredDocuments: number;
  durationMs: number;
  rtoMs: number;
}

export async function restoreLatestAndVerify(): Promise<RestoreDrillResult> {
  const started = Date.now();
  const prefix = process.env.BACKUP_S3_PREFIX ?? "backups";
  const pointer = await readSmallJson<{ manifestKey: string }>(`${prefix}/latest.json`);
  const manifest = await readSmallJson<BackupManifest>(pointer.manifestKey);
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error(`Unsupported backup format ${manifest.formatVersion}`);
  if (!verifyManifest(manifest)) throw new Error("Manifest signature verification failed");
  const rpoMs = Number(process.env.BACKUP_RPO_HOURS ?? 26) * 3_600_000;
  const backupAgeMs = Date.now() - new Date(manifest.completedAt).getTime();
  if (!Number.isFinite(backupAgeMs) || backupAgeMs < 0 || backupAgeMs > rpoMs) {
    throw new Error(`Latest backup violates RPO: age ${backupAgeMs}ms > ${rpoMs}ms`);
  }

  const sourceDb = mongoose.connection.db;
  if (!sourceDb) throw new Error("MongoDB not connected");
  const drillDbName = `${mongoose.connection.name}_restore_drill_${randomUUID().replace(/-/g, "")}`;
  const drillDb = sourceDb.client.db(drillDbName);
  let total = 0;
  try {
    for (const entry of manifest.collections) {
      const hash = createHash("sha256");
      let pending = "";
      let count = 0;
      let batch: Record<string, unknown>[] = [];
      const collection = drillDb.collection(entry.name);
      const checksum = new Transform({
        transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
      });
      const importer = new Transform({
        async transform(chunk: Buffer, _encoding, callback) {
          try {
            pending += chunk.toString("utf8");
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              if (!line) continue;
              batch.push(EJSON.parse(line, { relaxed: false }) as Record<string, unknown>);
              count++;
              if (batch.length >= 500) { await collection.insertMany(batch, { ordered: true }); batch = []; }
            }
            callback();
          } catch (error) { callback(error as Error); }
        },
        async flush(callback) {
          try {
            if (pending.trim()) { batch.push(EJSON.parse(pending, { relaxed: false }) as Record<string, unknown>); count++; }
            if (batch.length) await collection.insertMany(batch, { ordered: true });
            callback();
          } catch (error) { callback(error as Error); }
        },
      });
      await pipeline(await getObject(entry.key), checksum, createGunzip(), importer);
      if (hash.digest("hex") !== entry.sha256) throw new Error(`Checksum mismatch for ${entry.name}`);
      if (count !== entry.documents || await collection.countDocuments() !== entry.documents) {
        throw new Error(`Document count mismatch for ${entry.name}: expected ${entry.documents}, restored ${count}`);
      }
      total += count;
    }
    // Integrity smoke tests: IDs are unique by construction, all declared
    // collections exist, and the principal user/prompt references resolve.
    const names = new Set((await drillDb.listCollections().toArray()).map(c => c.name));
    for (const entry of manifest.collections) if (!names.has(entry.name)) throw new Error(`Missing restored collection ${entry.name}`);
    const danglingPromptPurchases = (await drillDb.collection("purchases").aggregate([
      { $lookup: { from: "prompts", localField: "promptId", foreignField: "_id", as: "prompt" } },
      { $match: { prompt: { $size: 0 } } }, { $limit: 1 }, { $count: "count" },
    ]).next())?.count ?? 0;
    if (danglingPromptPurchases) throw new Error(`${danglingPromptPurchases} purchases reference missing prompts`);
    const durationMs = Date.now() - started;
    const rtoMs = Number(process.env.BACKUP_RTO_MINUTES ?? 60) * 60_000;
    if (durationMs > rtoMs) throw new Error(`Restore exceeded RTO: ${durationMs}ms > ${rtoMs}ms`);
    await BackupRun.updateOne({ backupId: manifest.backupId }, { $set: { restoreVerifiedAt: new Date() } });
    return { backupId: manifest.backupId, restoredDocuments: total, durationMs, rtoMs };
  } finally {
    await drillDb.dropDatabase().catch(() => undefined);
  }
}

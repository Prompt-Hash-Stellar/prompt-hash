/**
 * Migration 001 — Add off-chain profile fields to User documents (#333)
 *
 * Run once:  npx ts-node server/src/db/migrations/001_user_profile_fields.ts
 *
 * What it does:
 *   - Adds displayName, bio, avatarUrl, socialLinks with empty defaults to all
 *     existing User documents that don't already have these fields.
 */

import "dotenv/config";
import mongoose from "mongoose";

export async function up(db: any): Promise<void> {
  const result = await db.collection("users").updateMany(
    {
      $or: [
        { displayName: { $exists: false } },
        { bio: { $exists: false } },
        { avatarUrl: { $exists: false } },
        { socialLinks: { $exists: false } },
      ],
    },
    {
      $set: {
        displayName: "",
        bio: "",
        avatarUrl: "",
        socialLinks: { twitter: "", github: "", website: "" },
      },
    },
  );
  console.log(`[001] Updated ${result.modifiedCount} user documents`);
}

export async function down(db: any): Promise<void> {
  const result = await db.collection("users").updateMany(
    {},
    {
      $unset: {
        displayName: "",
        bio: "",
        avatarUrl: "",
        socialLinks: "",
      },
    },
  );
  console.log(`[001] Rollback: removed off-chain profile fields from ${result.modifiedCount} user documents`);
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  await up(db);
  await mongoose.disconnect();
}

const isDirectRun =
  typeof require !== "undefined" && require.main === module ||
  (process.argv[1] && (
    process.argv[1].endsWith("001_user_profile_fields.ts") ||
    process.argv[1].endsWith("001_user_profile_fields.js")
  ));

if (isDirectRun) {
  run().catch((err) => {
    console.error("[001] Migration failed:", err);
    process.exit(1);
  });
}


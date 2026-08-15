import "dotenv/config";
import mongoose from "mongoose";
import connectDb from "./connectDb";
import { MIGRATIONS } from "./migrations/registry";
import { MigrationModel } from "../models/Migration";

export async function runMigrations(direction: "up" | "down" = "up"): Promise<void> {
  const connection = await connectDb();
  const db = connection.connection.db!;

  if (direction === "up") {
    console.log("🔄 Running migrations up...");
    // 1. Get already applied migrations
    const appliedMigrations = await MigrationModel.find().sort({ version: 1 }).exec();
    const appliedVersions = new Set(appliedMigrations.map((m) => m.version));

    // 2. Identify pending migrations
    const pendingMigrations = MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).sort(
      (a, b) => a.version - b.version
    );

    if (pendingMigrations.length === 0) {
      console.log("✅ Database is up to date. No migrations to run.");
      return;
    }

    // 3. Apply pending migrations sequentially
    for (const migration of pendingMigrations) {
      console.log(`🚀 Applying migration ${migration.version}: ${migration.name}...`);
      try {
        await migration.up(db);
        // Record applied migration
        await MigrationModel.create({
          version: migration.version,
          name: migration.name,
          appliedAt: new Date(),
        });
        console.log(`✅ Successfully applied migration: ${migration.name}`);
      } catch (error) {
        console.error(`❌ Migration failed: ${migration.name}`, error);
        throw error; // Let caller handle or process.exit
      }
    }
    console.log("✅ All migrations applied successfully.");
  } else if (direction === "down") {
    console.log("🔄 Rolling back migrations (down)...");
    // 1. Get the last applied migration from DB
    const lastApplied = await MigrationModel.findOne().sort({ version: -1 }).exec();
    if (!lastApplied) {
      console.log("ℹ️ No migrations to roll back.");
      return;
    }

    // 2. Find matching migration in registry
    const migration = MIGRATIONS.find((m) => m.version === lastApplied.version);
    if (!migration) {
      throw new Error(
        `Migration with version ${lastApplied.version} (${lastApplied.name}) was applied in the DB, but is missing from registry.`
      );
    }

    console.log(`↩️ Rolling back migration ${migration.version}: ${migration.name}...`);
    try {
      await migration.down(db);
      // Remove applied record
      await MigrationModel.deleteOne({ version: migration.version }).exec();
      console.log(`✅ Successfully rolled back migration: ${migration.name}`);
    } catch (error) {
      console.error(`❌ Rollback failed: ${migration.name}`, error);
      throw error;
    }
  } else {
    throw new Error(`Unsupported migration direction: ${direction}`);
  }
}

// CLI entry point
const isDirectRun =
  typeof require !== "undefined" && require.main === module ||
  (process.argv[1] && (
    process.argv[1].endsWith("migrationRunner.ts") ||
    process.argv[1].endsWith("migrationRunner.js")
  ));

if (isDirectRun) {
  const directionArg = process.argv[2];
  const direction = directionArg === "down" ? "down" : "up";

  console.log(`🏃 Starting migration runner CLI [direction = ${direction}]...`);
  runMigrations(direction)
    .then(() => {
      console.log("🎉 Migration process completed successfully.");
      mongoose.disconnect().then(() => process.exit(0));
    })
    .catch((error) => {
      console.error("💥 Critical migration runner error:", error);
      mongoose.disconnect().then(() => process.exit(1));
    });
}

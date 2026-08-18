import mongoose from "mongoose";
import { restoreLatestAndVerify } from "../src/services/restoreService";

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const result = await restoreLatestAndVerify();
    console.log(`[restore] Verified ${result.backupId}: ${result.restoredDocuments} documents in ${result.durationMs}ms`);
  } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error("[restore] Fatal:", error); process.exit(1); });

/**
 * One-off migration: merge duplicate Purchase records for the same
 * (promptId, buyerWallet) pair before the unique index on that pair is
 * enforced (see server/src/models/Purchase.ts).
 *
 * For each duplicate group:
 *   - Keeps the earliest purchase (by createdAt) as the canonical record and
 *     its versionIndex, since that reflects what the buyer actually paid for
 *     first.
 *   - Preserves transaction evidence (txHash) from later duplicates: if the
 *     earliest record has no txHash but a later duplicate does, that txHash
 *     is copied onto the surviving record instead of being discarded.
 *   - Deletes the redundant duplicate records.
 *
 * Usage:
 *   ts-node server/scripts/dedupePurchases.ts [--dry-run]
 *
 * Required environment variables:
 *   MONGODB_URI
 */

import mongoose from "mongoose";
import Purchase from "../src/models/Purchase";

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("MONGODB_URI is not set");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log(`[dedupePurchases] Connected to MongoDB at ${new Date().toISOString()}${dryRun ? " (dry run)" : ""}`);

  try {
    const duplicateGroups = await Purchase.aggregate([
      {
        $group: {
          _id: { promptId: "$promptId", buyerWallet: "$buyerWallet" },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]);

    console.log(`[dedupePurchases] Found ${duplicateGroups.length} duplicate (promptId, buyerWallet) groups.`);

    let mergedGroups = 0;
    let deletedRecords = 0;

    for (const group of duplicateGroups) {
      const records = await Purchase.find({ _id: { $in: group.ids } }).sort({ createdAt: 1 });
      if (records.length < 2) continue;

      const [canonical, ...duplicates] = records;

      // Preserve the earliest non-empty txHash evidence in case the
      // canonical (earliest) record was created before the on-chain
      // confirmation was recorded.
      const survivingTxHash =
        canonical.txHash && canonical.txHash.length > 0
          ? canonical.txHash
          : duplicates.find((d) => d.txHash && d.txHash.length > 0)?.txHash ?? canonical.txHash;

      console.log(
        `[dedupePurchases] promptId=${group._id.promptId} buyerWallet=${group._id.buyerWallet}: ` +
          `keeping ${canonical._id} (versionIndex=${canonical.versionIndex}), removing ${duplicates.length} duplicate(s).`,
      );

      if (!dryRun) {
        if (survivingTxHash !== canonical.txHash) {
          await Purchase.updateOne({ _id: canonical._id }, { $set: { txHash: survivingTxHash } });
        }
        await Purchase.deleteMany({ _id: { $in: duplicates.map((d) => d._id) } });
      }

      mergedGroups += 1;
      deletedRecords += duplicates.length;
    }

    console.log(
      `[dedupePurchases] Done. ${mergedGroups} groups merged, ${deletedRecords} duplicate records ${dryRun ? "would be " : ""}removed.`,
    );

    if (!dryRun) {
      console.log("[dedupePurchases] Run `Purchase.syncIndexes()` (or restart the server) to build the unique index.");
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("[dedupePurchases] Fatal:", err);
  process.exit(1);
});

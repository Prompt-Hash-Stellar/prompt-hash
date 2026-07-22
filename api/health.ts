import { withObservability } from "../src/lib/observability/wrapper";
import { IndexerState } from "../server/src/models/IndexerState";
import connectDb from "../server/src/db/connectDb";

async function handler(_req: any, res: any) {
  await connectDb();
  const state = await IndexerState.findOne({ key: "prompt_hash_contract" });

  const status = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
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
    },
  };

  res.status(200).json(status);
}

export default withObservability(handler, "health");

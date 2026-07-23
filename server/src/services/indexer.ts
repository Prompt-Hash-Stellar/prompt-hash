import { scValToNative } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import Prompt from "../models/Prompt";
import User from "../models/User";
import Purchase from "../models/Purchase";
import { IndexerState } from "../models/IndexerState";
import { scanForSimilarity } from "./similarityDetection";
import { indexPromptProjection } from "./promptSearchIndex";
import { loadStellarConfig } from "../config/stellar";

const stellarConfig = loadStellarConfig();

const CONTRACT_ID = stellarConfig.PUBLIC_PROMPT_HASH_CONTRACT_ID;
const rpc = new Server(stellarConfig.PUBLIC_STELLAR_RPC_URL);

/**
 * Main entry point to start the background indexing process.
 */
export async function startIndexer() {
  const state = await IndexerState.findOneAndUpdate(
    { key: "prompt_hash_contract" },
    { $setOnInsert: { lastIndexedLedger: 0 } },
    { upsert: true, new: true },
  );

  // Poll every 5 seconds
  setInterval(async () => {
    try {
      const latestLedger = await rpc.getLatestLedger();
      const startLedger = (state.lastIndexedLedger || 0) + 1;

      // Only fetch if there are new ledgers to process
      if (startLedger > latestLedger.sequence) return;

      const response = await rpc.getEvents({
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds: [CONTRACT_ID],
          },
        ],
      });

      for (const event of response.events) {
        await processEvent(event);
      }

      // Update the cursor to the last processed ledger
      state.lastIndexedLedger = latestLedger.sequence;
      await state.save();
    } catch (err) {
      console.error("Indexer Error:", err);
    }
  }, 5000);
}

/**
 * Decodes and routes Soroban events to the appropriate database action.
 */
async function processEvent(event: any) {
  // Decode the topic and value from XDR to Native JS types
  const topic = scValToNative(event.topic[0]);
  const data = scValToNative(event.value);

  console.log(`Processing Event: ${topic}`, data);

  switch (topic) {
    case "PromptCreated": {
      const { prompt_id, creator, price_stroops } = data;

      // Ensure the creator exists in our User collection
      let user = await User.findOne({ walletAddress: creator.toLowerCase() });
      if (!user) {
        user = await User.create({
          walletAddress: creator.toLowerCase(),
          username: `user_${creator.slice(0, 6)}`,
          rating: 4,
        });
      }

      // handles discovery of prompts created off-platform
      const upserted = await Prompt.findOneAndUpdate(
        { onChainId: prompt_id.toString() },
        {
          $set: {
            onChainId: prompt_id.toString(),
            owner: user._id,
            price: Number(price_stroops) / 10_000_000,
            isActive: true,
          },
        },
        { upsert: true, new: true },
      );

      await indexPromptProjection(upserted, creator, Number(event.ledger || 0));

      // Run similarity scan asynchronously — never block the indexer loop.
      if (upserted?.content) {
        const combinedText = `${upserted.title ?? ""} ${upserted.content}`;
        scanForSimilarity(prompt_id.toString(), combinedText).catch((err) =>
          console.error("[similarity] Scan error for prompt", prompt_id.toString(), err),
        );
      }
      break;
    }

    case "PromptPurchased": {
      const { prompt_id, buyer, tx_hash, version_index } = data;
      await Prompt.findOneAndUpdate(
        { onChainId: prompt_id.toString() },
        { $inc: { salesCount: 1 } },
      );
      if (buyer) {
        await Purchase.findOneAndUpdate(
          { promptId: prompt_id.toString(), buyerWallet: String(buyer).toLowerCase() },
          {
            $set: {
              promptId: prompt_id.toString(),
              buyerWallet: String(buyer).toLowerCase(),
              versionIndex: version_index ?? 1,
              txHash: tx_hash ?? event.txHash ?? "",
            },
          },
          { upsert: true }
        );
      }
      break;
    }

    case "PromptPriceUpdated": {
      const { prompt_id, price_stroops } = data;
      await Prompt.findOneAndUpdate(
        { onChainId: prompt_id.toString() },
        { $set: { price: Number(price_stroops) / 10_000_000 } },
      );
      break;
    }

    case "PromptSaleStatusUpdated": {
      const { prompt_id, active } = data;
      await Prompt.findOneAndUpdate(
        { onChainId: prompt_id.toString() },
        { $set: { isActive: active } },
      );
      const indexed = await Prompt.findOne({ onChainId: prompt_id.toString() }).populate("owner").lean();
      if (indexed) await indexPromptProjection(indexed, indexed.owner?.walletAddress || "unknown", Number(event.ledger || 0));
      break;
    }

    default:
      console.log(`Unhandled event topic: ${topic}`);
      break;
  }
}

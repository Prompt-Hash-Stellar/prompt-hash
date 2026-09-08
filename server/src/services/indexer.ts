import { scValToNative } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import Prompt from "../models/Prompt";
import User from "../models/User";
import Purchase from "../models/Purchase";
import { IndexerState } from "../models/IndexerState";
import { enqueueSimilarityScan, startSimilarityWorker } from "./similarityJobQueue";
import { indexPromptProjection } from "./promptSearchIndex";
import { stellarConfig } from "../config/stellar";
import { cacheDel, cacheDelPattern, CACHE_KEYS } from "./cacheService";
import { decodeContractEvent } from "./eventDecoder";
import { DeadLetterQueueService } from "./deadLetterQueue";

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

  // Start the similarity scan worker (processes queued jobs)
  // Non-blocking, runs on 5-second intervals
  startSimilarityWorker(5000);

  // Poll for new blockchain events every 5 seconds
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
export async function processEvent(event: any) {
  const topic = scValToNative(event.topic[0]);
  const data = scValToNative(event.value);

  console.log(`Processing Event: ${topic}`, data);

  switch (topic) {
    case "PromptCreated": {
      const decodeResult = decodeContractEvent({
        topic: [topic],
        value: data,
        ledger: event.ledger,
        transaction: event.txHash ?? event.transaction,
        eventIndex: event.eventIndex,
      });

      if (!decodeResult.success) {
        await DeadLetterQueueService.routeToDeadLetter(decodeResult.deadLetter);
        console.warn(`[indexer] Quarantined invalid PromptCreated event: ${decodeResult.deadLetter.reason}`);
        return;
      }

      const decoded = decodeResult.event;
      if (decoded.eventType !== "publish") return;

      let user = await User.findOne({ walletAddress: decoded.creator.toLowerCase() });
      if (!user) {
        user = await User.create({
          walletAddress: decoded.creator.toLowerCase(),
          username: `user_${decoded.creator.slice(0, 6)}`,
          rating: 4,
        });
      }

      const upserted = await Prompt.findOneAndUpdate(
        { onChainId: decoded.promptId },
        {
          $set: {
            onChainId: decoded.promptId,
            owner: user._id,
            price: decoded.priceXlm,
            isActive: true,
          },
        },
        { upsert: true, new: true },
      );

      await indexPromptProjection(upserted, decoded.creator, Number(event.ledger || 0));

      if (upserted?.content) {
        enqueueSimilarityScan(decoded.promptId).catch((err) =>
          console.error(
            "[similarity-queue] Failed to enqueue scan for prompt",
            decoded.promptId,
            err,
          ),
        );
      }
      break;
    }

    case "PromptPurchased": {
      const decodeResult = decodeContractEvent({
        topic: [topic],
        value: data,
        ledger: event.ledger,
        transaction: event.txHash ?? event.transaction,
        eventIndex: event.eventIndex,
      });

      if (!decodeResult.success) {
        await DeadLetterQueueService.routeToDeadLetter(decodeResult.deadLetter);
        console.warn(`[indexer] Quarantined invalid PromptPurchased event: ${decodeResult.deadLetter.reason}`);
        return;
      }

      const decoded = decodeResult.event;
      if (decoded.eventType !== "purchase") return;

      await Prompt.findOneAndUpdate(
        { onChainId: decoded.promptId },
        { $inc: { salesCount: 1 } },
      );

      if (decoded.buyer) {
        await Purchase.findOneAndUpdate(
          { promptId: decoded.promptId, buyerWallet: decoded.buyer.toLowerCase() },
          {
            $set: {
              promptId: decoded.promptId,
              buyerWallet: decoded.buyer.toLowerCase(),
              versionIndex: decoded.versionIndex,
              txHash: decoded.txHash ?? "",
            },
          },
          { upsert: true },
        );
      }
      break;
    }

    case "PromptUnlocked": {
      const decodeResult = decodeContractEvent({
        topic: [topic],
        value: data,
        ledger: event.ledger,
        transaction: event.txHash ?? event.transaction,
        eventIndex: event.eventIndex,
      });

      if (!decodeResult.success) {
        await DeadLetterQueueService.routeToDeadLetter(decodeResult.deadLetter);
        console.warn(`[indexer] Quarantined invalid PromptUnlocked event: ${decodeResult.deadLetter.reason}`);
        return;
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

  // Invalidate caches if this event updated a prompt
  if (["PromptCreated", "PromptPurchased", "PromptPriceUpdated", "PromptSaleStatusUpdated"].includes(topic)) {
    const promptIdStr = data.prompt_id?.toString();
    if (promptIdStr) {
      await cacheDel(CACHE_KEYS.promptDetail(promptIdStr));
      await cacheDelPattern("prompts:list:*");
      await cacheDelPattern("prompts:search:*");
    }
  }
}

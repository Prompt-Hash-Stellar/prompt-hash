import mongoose from "mongoose";
import { DeadLetterRecord } from "../types/eventVersioning";
import { DeadLetterEvent } from "../models/DeadLetterEvent";

const inMemoryDeadLetters: DeadLetterRecord[] = [];
const MAX_IN_MEMORY_ENTRIES = 1000;

/**
 * Dead Letter Queue service for routing, storing, and inspecting quarantined contract events.
 */
export class DeadLetterQueueService {
  /**
   * Enqueues an unparseable or unsupported contract event into quarantine.
   */
  public static async routeToDeadLetter(
    record: DeadLetterRecord,
  ): Promise<DeadLetterRecord> {
    inMemoryDeadLetters.unshift(record);
    if (inMemoryDeadLetters.length > MAX_IN_MEMORY_ENTRIES) {
      inMemoryDeadLetters.pop();
    }

    if (mongoose.connection?.readyState === 1) {
      try {
        await DeadLetterEvent.findOneAndUpdate(
          { eventId: record.eventId },
          record,
          { upsert: true, new: true },
        );
      } catch {
        return record;
      }
    }

    return record;
  }

  /**
   * Retrieves quarantined dead letter entries matching optional criteria.
   */
  public static async getDeadLetterRecords(filter?: {
    reason?: string;
    eventType?: string;
  }): Promise<DeadLetterRecord[]> {
    if (mongoose.connection?.readyState === 1) {
      try {
        const query: Record<string, unknown> = {};
        if (filter?.reason) query.reason = filter.reason;
        if (filter?.eventType) query.eventType = filter.eventType;
        const docs = await DeadLetterEvent.find(query)
          .sort({ createdAt: -1 })
          .lean();
        if (docs.length > 0) {
          return docs.map((doc: any) => ({
            eventId: doc.eventId,
            eventType: doc.eventType,
            detectedVersion: doc.detectedVersion,
            reason: doc.reason,
            details: doc.details,
            rawPayload: doc.rawPayload,
            ledger: doc.ledger,
            transaction: doc.transaction,
            eventIndex: doc.eventIndex,
            timestamp: doc.timestamp,
            recoverable: doc.recoverable,
          }));
        }
      } catch {
      }
    }

    return inMemoryDeadLetters.filter((entry) => {
      if (filter?.reason && entry.reason !== filter.reason) return false;
      if (filter?.eventType && entry.eventType !== filter.eventType) return false;
      return true;
    });
  }

  /**
   * Clears all quarantined dead letter records.
   */
  public static async clearDeadLetterRecords(): Promise<void> {
    inMemoryDeadLetters.length = 0;
    if (mongoose.connection?.readyState === 1) {
      try {
        await DeadLetterEvent.deleteMany({});
      } catch {
      }
    }
  }

  /**
   * Returns total count of quarantined events.
   */
  public static async getDeadLetterCount(): Promise<number> {
    if (mongoose.connection?.readyState === 1) {
      try {
        return await DeadLetterEvent.countDocuments();
      } catch {
        return inMemoryDeadLetters.length;
      }
    }
    return inMemoryDeadLetters.length;
  }
}

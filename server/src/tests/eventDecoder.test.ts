import fs from "fs";
import path from "path";
import {
  decodeContractEvent,
  detectEventVersion,
  isSupportedVersion,
  resolveEventType,
} from "../services/eventDecoder";
import { DeadLetterQueueService } from "../services/deadLetterQueue";

describe("Event Decoder & Version Compatibility", () => {
  const fixturesDir = path.resolve(__dirname, "../fixtures/events");

  beforeEach(async () => {
    await DeadLetterQueueService.clearDeadLetterRecords();
  });

  describe("Version and Type Detection", () => {
    it("recognizes supported versions 1 and 2", () => {
      expect(isSupportedVersion(1)).toBe(true);
      expect(isSupportedVersion(2)).toBe(true);
      expect(isSupportedVersion(3)).toBe(false);
      expect(isSupportedVersion(99)).toBe(false);
    });

    it("resolves event types from topics", () => {
      expect(resolveEventType(["PromptCreated", "1"])).toBe("publish");
      expect(resolveEventType(["publish", "1"])).toBe("publish");
      expect(resolveEventType(["PromptPurchased", "1"])).toBe("purchase");
      expect(resolveEventType(["purchase", "1"])).toBe("purchase");
      expect(resolveEventType(["PromptUnlocked", "1"])).toBe("unlock");
      expect(resolveEventType(["unlock", "1"])).toBe("unlock");
      expect(resolveEventType(["UnknownTopic"])).toBeNull();
      expect(resolveEventType([])).toBeNull();
    });

    it("detects schema version from topic tokens and payload properties", () => {
      expect(detectEventVersion(["PromptCreated", "1", "v2"], {})).toBe(2);
      expect(detectEventVersion(["PromptCreated", "1"], { schema_version: 2 })).toBe(2);
      expect(detectEventVersion(["PromptCreated", "1"], { version: 2 })).toBe(2);
      expect(detectEventVersion(["PromptCreated", "1"], {})).toBe(1);
      expect(detectEventVersion(["PromptCreated", "1", "v99"], {})).toBe(99);
    });
  });

  describe("Supported Event Fixtures", () => {
    it("decodes publish v1 fixture deterministically", () => {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, "publish.v1.json"), "utf8"),
      );
      const result = decodeContractEvent(fixture.rawEvent);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.event).toEqual(fixture.expectedCanonical);
      }
    });

    it("decodes publish v2 fixture deterministically", () => {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, "publish.v2.json"), "utf8"),
      );
      const result = decodeContractEvent(fixture.rawEvent);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.event).toEqual(fixture.expectedCanonical);
      }
    });

    it("decodes purchase v1 fixture deterministically", () => {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, "purchase.v1.json"), "utf8"),
      );
      const result = decodeContractEvent(fixture.rawEvent);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.event).toEqual(fixture.expectedCanonical);
      }
    });

    it("decodes purchase v2 fixture deterministically", () => {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, "purchase.v2.json"), "utf8"),
      );
      const result = decodeContractEvent(fixture.rawEvent);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.event).toEqual(fixture.expectedCanonical);
      }
    });

    it("decodes unlock v1 fixture deterministically", () => {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, "unlock.v1.json"), "utf8"),
      );
      const result = decodeContractEvent(fixture.rawEvent);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.event).toEqual(fixture.expectedCanonical);
      }
    });

    it("decodes unlock v2 fixture deterministically", () => {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, "unlock.v2.json"), "utf8"),
      );
      const result = decodeContractEvent(fixture.rawEvent);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.event).toEqual(fixture.expectedCanonical);
      }
    });
  });

  describe("Unsupported Versions & Dead Letter Routing", () => {
    it("fails safely and dead-letters unknown event topics", async () => {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, "unsupported.unknown_topic.json"), "utf8"),
      );
      const result = decodeContractEvent(fixture.rawEvent);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.deadLetter.reason).toBe(fixture.expectedDeadLetter.reason);
        expect(result.deadLetter.recoverable).toBe(fixture.expectedDeadLetter.recoverable);
        await DeadLetterQueueService.routeToDeadLetter(result.deadLetter);
      }

      const deadLetters = await DeadLetterQueueService.getDeadLetterRecords({
        reason: "UNKNOWN_EVENT_TYPE",
      });
      expect(deadLetters.length).toBe(1);
    });

    it("fails safely and dead-letters unsupported schema versions", async () => {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, "unsupported.invalid_version.json"), "utf8"),
      );
      const result = decodeContractEvent(fixture.rawEvent);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.deadLetter.reason).toBe(fixture.expectedDeadLetter.reason);
        expect(result.deadLetter.recoverable).toBe(fixture.expectedDeadLetter.recoverable);
        expect(String(result.deadLetter.detectedVersion)).toBe(fixture.expectedDeadLetter.detectedVersion);
        await DeadLetterQueueService.routeToDeadLetter(result.deadLetter);
      }

      const count = await DeadLetterQueueService.getDeadLetterCount();
      expect(count).toBe(1);
    });

    it("fails safely and dead-letters malformed payloads", async () => {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, "unsupported.malformed_payload.json"), "utf8"),
      );
      const result = decodeContractEvent(fixture.rawEvent);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.deadLetter.reason).toBe(fixture.expectedDeadLetter.reason);
        expect(result.deadLetter.recoverable).toBe(fixture.expectedDeadLetter.recoverable);
        await DeadLetterQueueService.routeToDeadLetter(result.deadLetter);
      }

      const records = await DeadLetterQueueService.getDeadLetterRecords({
        reason: "SCHEMA_VALIDATION_FAILED",
      });
      expect(records.length).toBe(1);
    });

    it("handles null or non-object raw envelopes without throwing", () => {
      const resultNull = decodeContractEvent(null as any);
      expect(resultNull.success).toBe(false);
      if (!resultNull.success) {
        expect(resultNull.deadLetter.reason).toBe("CORRUPT_PAYLOAD");
      }

      const resultUndefined = decodeContractEvent(undefined as any);
      expect(resultUndefined.success).toBe(false);
      if (!resultUndefined.success) {
        expect(resultUndefined.deadLetter.reason).toBe("CORRUPT_PAYLOAD");
      }
    });

    it("handles missing mandatory fields gracefully", () => {
      const invalidPublish = decodeContractEvent({
        topic: ["PromptCreated", "1"],
        value: {
          prompt_id: 1,
          price_stroops: 10000000,
        },
      });
      expect(invalidPublish.success).toBe(false);
      if (!invalidPublish.success) {
        expect(invalidPublish.deadLetter.reason).toBe("SCHEMA_VALIDATION_FAILED");
        expect(invalidPublish.deadLetter.details).toContain("creator");
      }

      const invalidUnlock = decodeContractEvent({
        topic: ["PromptUnlocked", "1"],
        value: {
          prompt_id: 1,
          buyer: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
          timestamp: -10,
        },
      });
      expect(invalidUnlock.success).toBe(false);
      if (!invalidUnlock.success) {
        expect(invalidUnlock.deadLetter.reason).toBe("SCHEMA_VALIDATION_FAILED");
        expect(invalidUnlock.deadLetter.details).toContain("timestamp");
      }
    });
  });
});

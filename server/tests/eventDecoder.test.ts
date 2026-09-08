import fs from "fs";
import path from "path";
import { decodeContractEvent } from "../src/services/eventDecoder";
import { DeadLetterQueueService } from "../src/services/deadLetterQueue";

describe("Root Server Tests: Event Decoder and Compatibility", () => {
  const fixturesDir = path.resolve(__dirname, "fixtures/events");

  beforeEach(async () => {
    await DeadLetterQueueService.clearDeadLetterRecords();
  });

  it("verifies manifest integrity", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, "manifest.json"), "utf8"),
    );
    expect(manifest.supportedEventTypes).toEqual(["publish", "purchase", "unlock"]);
    expect(manifest.supportedVersions).toEqual([1, 2]);
    expect(manifest.fixtures.supported.length).toBe(6);
    expect(manifest.fixtures.unsupported.length).toBe(3);
  });

  it("verifies all fixtures in manifest execute deterministically", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, "manifest.json"), "utf8"),
    );

    for (const fixtureMeta of manifest.fixtures.supported) {
      const fixtureData = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, fixtureMeta.path), "utf8"),
      );
      const decoded = decodeContractEvent(fixtureData.rawEvent);
      expect(decoded.success).toBe(true);
      if (decoded.success) {
        expect(decoded.event.eventType).toBe(fixtureMeta.eventType);
        expect(decoded.event.version).toBe(fixtureMeta.version);
        expect(decoded.event).toEqual(fixtureData.expectedCanonical);
      }
    }

    for (const unsupportedMeta of manifest.fixtures.unsupported) {
      const fixtureData = JSON.parse(
        fs.readFileSync(path.join(fixturesDir, unsupportedMeta.path), "utf8"),
      );
      const decoded = decodeContractEvent(fixtureData.rawEvent);
      expect(decoded.success).toBe(false);
      if (!decoded.success) {
        expect(decoded.deadLetter.reason).toBe(fixtureData.expectedDeadLetter.reason);
      }
    }
  });
});

/**
 * tests/event_compatibility.test.ts
 *
 * Validates that the prompt-hash contract event decoder correctly handles
 * versioned event fixtures (issue #246):
 *  - Successfully decodes all v1 fixtures (publish, purchase, unlock).
 *  - Routes unsupported / future schema versions to the dead-letter path
 *    rather than throwing or silently discarding them.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'events');

// ---------------------------------------------------------------------------
// Minimal in-process event decoder (mirrors the expected SDK / indexer logic)
// ---------------------------------------------------------------------------

/** Supported schema versions that consumers can decode. */
const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);

interface ContractEvent {
  schema_version: number;
  event_type: string;
  topics: Record<string, unknown>;
  data: Record<string, unknown>;
  ledger: number;
  timestamp: string;
}

interface DecodeResult {
  ok: boolean;
  event?: ContractEvent;
  /** Populated when `ok` is false — the event goes to the dead-letter queue. */
  deadLetter?: { reason: string; raw: ContractEvent };
}

/**
 * Decodes a raw event object.
 * Returns `{ ok: true, event }` for supported versions.
 * Returns `{ ok: false, deadLetter }` for unsupported versions so that
 * consumers can route them appropriately without crashing.
 */
function decodeEvent(raw: ContractEvent): DecodeResult {
  if (!SUPPORTED_SCHEMA_VERSIONS.has(raw.schema_version)) {
    return {
      ok: false,
      deadLetter: {
        reason: `Unsupported schema_version: ${raw.schema_version}`,
        raw,
      },
    };
  }

  // Minimal required-field validation for the known v1 event types.
  switch (raw.event_type) {
    case 'PromptCreated':
      if (raw.topics.prompt_id === undefined || raw.data.creator === undefined) {
        return { ok: false, deadLetter: { reason: 'PromptCreated: missing required fields', raw } };
      }
      break;
    case 'PromptPurchased':
      if (
        raw.topics.prompt_id === undefined ||
        raw.topics.buyer === undefined ||
        raw.topics.creator === undefined
      ) {
        return { ok: false, deadLetter: { reason: 'PromptPurchased: missing required topic fields', raw } };
      }
      break;
    case 'EscrowReleased':
      if (raw.topics.prompt_id === undefined || raw.topics.buyer === undefined) {
        return { ok: false, deadLetter: { reason: 'EscrowReleased: missing required topic fields', raw } };
      }
      break;
    default:
      // Unknown event types for v1 are passed through as-is so that
      // new events added by minor contract updates don't break old consumers.
      break;
  }

  return { ok: true, event: raw };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function loadFixture(filename: string): ContractEvent {
  const content = readFileSync(join(FIXTURES_DIR, filename), 'utf-8');
  return JSON.parse(content) as ContractEvent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Contract event versioned fixtures (issue #246)', () => {
  // --- v1 publish event ---
  describe('v1_publish_event (PromptCreated)', () => {
    const raw = loadFixture('v1_publish_event.json');

    it('fixture has schema_version 1', () => {
      expect(raw.schema_version).toBe(1);
    });

    it('fixture has event_type PromptCreated', () => {
      expect(raw.event_type).toBe('PromptCreated');
    });

    it('decoder accepts the fixture and returns ok', () => {
      const result = decodeEvent(raw);
      expect(result.ok).toBe(true);
      expect(result.event).toBeDefined();
    });

    it('decoded event contains prompt_id topic', () => {
      const result = decodeEvent(raw);
      expect(result.event!.topics.prompt_id).toBeDefined();
    });

    it('decoded event contains creator in data', () => {
      const result = decodeEvent(raw);
      expect(result.event!.data.creator).toBeDefined();
    });

    it('decoded event contains price_stroops in data', () => {
      const result = decodeEvent(raw);
      expect(typeof result.event!.data.price_stroops).toBe('number');
    });
  });

  // --- v1 purchase event ---
  describe('v1_purchase_event (PromptPurchased)', () => {
    const raw = loadFixture('v1_purchase_event.json');

    it('fixture has schema_version 1', () => {
      expect(raw.schema_version).toBe(1);
    });

    it('fixture has event_type PromptPurchased', () => {
      expect(raw.event_type).toBe('PromptPurchased');
    });

    it('decoder accepts the fixture and returns ok', () => {
      const result = decodeEvent(raw);
      expect(result.ok).toBe(true);
    });

    it('decoded event contains buyer and creator topics', () => {
      const result = decodeEvent(raw);
      expect(result.event!.topics.buyer).toBeDefined();
      expect(result.event!.topics.creator).toBeDefined();
    });

    it('decoded event allows null referrer', () => {
      const result = decodeEvent(raw);
      expect(result.event!.data.referrer).toBeNull();
    });
  });

  // --- v1 unlock event ---
  describe('v1_unlock_event (EscrowReleased)', () => {
    const raw = loadFixture('v1_unlock_event.json');

    it('fixture has schema_version 1', () => {
      expect(raw.schema_version).toBe(1);
    });

    it('fixture has event_type EscrowReleased', () => {
      expect(raw.event_type).toBe('EscrowReleased');
    });

    it('decoder accepts the fixture and returns ok', () => {
      const result = decodeEvent(raw);
      expect(result.ok).toBe(true);
    });

    it('decoded event contains prompt_id and buyer topics', () => {
      const result = decodeEvent(raw);
      expect(result.event!.topics.prompt_id).toBeDefined();
      expect(result.event!.topics.buyer).toBeDefined();
    });
  });

  // --- Dead-letter routing for unsupported schema versions ---
  describe('Dead-letter routing for unsupported schema versions', () => {
    it('routes schema_version 2 (future) to dead letter', () => {
      const futureEvent: ContractEvent = {
        schema_version: 2,
        event_type: 'PromptCreated',
        topics: { prompt_id: 99 },
        data: { creator: 'GB...', price_stroops: 5000000, asset: 'CD...' },
        ledger: 9999999,
        timestamp: '2099-01-01T00:00:00Z',
      };
      const result = decodeEvent(futureEvent);
      expect(result.ok).toBe(false);
      expect(result.deadLetter).toBeDefined();
      expect(result.deadLetter!.reason).toContain('Unsupported schema_version: 2');
    });

    it('routes schema_version 0 (legacy/unknown) to dead letter', () => {
      const legacyEvent: ContractEvent = {
        schema_version: 0,
        event_type: 'PromptPurchased',
        topics: { prompt_id: 1 },
        data: {},
        ledger: 100,
        timestamp: '2023-01-01T00:00:00Z',
      };
      const result = decodeEvent(legacyEvent);
      expect(result.ok).toBe(false);
      expect(result.deadLetter!.reason).toContain('Unsupported schema_version: 0');
    });

    it('preserves raw event in dead-letter payload for audit', () => {
      const unknownEvent: ContractEvent = {
        schema_version: 99,
        event_type: 'UnknownFutureEvent',
        topics: {},
        data: { foo: 'bar' },
        ledger: 5000000,
        timestamp: '2050-06-15T12:00:00Z',
      };
      const result = decodeEvent(unknownEvent);
      expect(result.deadLetter!.raw).toEqual(unknownEvent);
    });

    it('does NOT throw when receiving an unsupported version', () => {
      const badEvent: ContractEvent = {
        schema_version: 999,
        event_type: 'PromptCreated',
        topics: {},
        data: {},
        ledger: 1,
        timestamp: '2030-01-01T00:00:00Z',
      };
      expect(() => decodeEvent(badEvent)).not.toThrow();
    });
  });
});

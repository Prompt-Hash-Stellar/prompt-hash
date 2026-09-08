/**
 * Contract event versioning and canonical representation types.
 */

export type SupportedEventVersion = 1 | 2;

export const SUPPORTED_EVENT_VERSIONS: readonly SupportedEventVersion[] = [1, 2] as const;

export type ContractEventType = "publish" | "purchase" | "unlock";

export type DeadLetterReason =
  | "UNKNOWN_EVENT_TYPE"
  | "UNSUPPORTED_VERSION"
  | "SCHEMA_VALIDATION_FAILED"
  | "CORRUPT_PAYLOAD";

export interface RawEventEnvelope {
  topic: (string | number)[];
  value: unknown;
  ledger?: number;
  transaction?: string;
  eventIndex?: number;
}

export interface CanonicalPublishEvent {
  eventType: "publish";
  version: SupportedEventVersion;
  promptId: string;
  creator: string;
  priceStroops: string;
  priceXlm: number;
  asset: string;
  title: string | null;
  category: string | null;
  metadataUri: string | null;
  contentHash: string | null;
}

export interface CanonicalPurchaseEvent {
  eventType: "purchase";
  version: SupportedEventVersion;
  promptId: string;
  buyer: string;
  creator: string;
  priceStroops: string;
  priceXlm: number;
  referrer: string | null;
  referralFeeStroops: string | null;
  referralFeeXlm: number | null;
  txHash: string | null;
  versionIndex: number;
}

export interface CanonicalUnlockEvent {
  eventType: "unlock";
  version: SupportedEventVersion;
  promptId: string;
  buyer: string;
  timestamp: number;
  requestId: string | null;
  clientSession: string | null;
}

export type CanonicalContractEvent =
  | CanonicalPublishEvent
  | CanonicalPurchaseEvent
  | CanonicalUnlockEvent;

export interface DeadLetterRecord {
  eventId: string;
  eventType: string;
  detectedVersion: string | number | null;
  reason: DeadLetterReason;
  details: string;
  rawPayload: unknown;
  ledger: number | null;
  transaction: string | null;
  eventIndex: number | null;
  timestamp: number;
  recoverable: boolean;
}

export type DecodeResult =
  | { success: true; event: CanonicalContractEvent }
  | { success: false; deadLetter: DeadLetterRecord };

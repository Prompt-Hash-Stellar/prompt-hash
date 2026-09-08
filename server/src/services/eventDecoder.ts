import {
  CanonicalContractEvent,
  CanonicalPublishEvent,
  CanonicalPurchaseEvent,
  CanonicalUnlockEvent,
  ContractEventType,
  DeadLetterRecord,
  DecodeResult,
  RawEventEnvelope,
  SUPPORTED_EVENT_VERSIONS,
  SupportedEventVersion,
} from "../types/eventVersioning";

const STROOPS_PER_XLM = 10_000_000;

/**
 * Validates whether an event version is currently supported by consumers.
 */
export function isSupportedVersion(
  version: number,
): version is SupportedEventVersion {
  return (SUPPORTED_EVENT_VERSIONS as readonly number[]).includes(version);
}

/**
 * Resolves event type identifier from contract topic tokens.
 */
export function resolveEventType(
  topicTokens: (string | number)[],
): ContractEventType | null {
  if (!topicTokens || topicTokens.length === 0) {
    return null;
  }
  const primaryToken = String(topicTokens[0]).trim();
  switch (primaryToken) {
    case "PromptCreated":
    case "publish":
      return "publish";
    case "PromptPurchased":
    case "purchase":
      return "purchase";
    case "PromptUnlocked":
    case "unlock":
      return "unlock";
    default:
      return null;
  }
}

/**
 * Inspects topic tokens and payload properties to detect schema version.
 */
export function detectEventVersion(
  topicTokens: (string | number)[],
  payload: any,
): number | null {
  for (const token of topicTokens) {
    const str = String(token).trim();
    const versionMatch = str.match(/^v?([0-9]+)$/i);
    if (versionMatch && str.toLowerCase().startsWith("v")) {
      return Number(versionMatch[1]);
    }
  }

  if (payload && typeof payload === "object") {
    if ("schema_version" in payload && payload.schema_version !== undefined) {
      return Number(payload.schema_version);
    }
    if ("version" in payload && typeof payload.version === "number") {
      return Number(payload.version);
    }
  }

  return 1;
}

/**
 * Decodes publish (PromptCreated) events across schema versions.
 */
function decodePublishEvent(
  version: SupportedEventVersion,
  payload: any,
): CanonicalPublishEvent {
  const promptId = String(payload.prompt_id ?? payload.id);
  const creator = String(payload.creator);
  const asset = String(payload.asset);

  if (!promptId || promptId === "undefined" || promptId === "null") {
    throw new Error("Missing required field: prompt_id");
  }
  if (!creator || creator === "undefined" || creator === "null") {
    throw new Error("Missing required field: creator");
  }
  if (!asset || asset === "undefined" || asset === "null") {
    throw new Error("Missing required field: asset");
  }

  const stroopsRaw = payload.price_stroops ?? payload.price;
  if (stroopsRaw === undefined || stroopsRaw === null) {
    throw new Error("Missing required field: price_stroops");
  }

  const stroopsBigInt = BigInt(stroopsRaw);
  if (stroopsBigInt < 0n) {
    throw new Error("Invalid price_stroops: value cannot be negative");
  }

  const priceStroops = stroopsBigInt.toString();
  const priceXlm = Number(stroopsBigInt) / STROOPS_PER_XLM;

  if (version === 1) {
    return {
      eventType: "publish",
      version: 1,
      promptId,
      creator,
      priceStroops,
      priceXlm,
      asset,
      title: null,
      category: null,
      metadataUri: null,
      contentHash: null,
    };
  }

  return {
    eventType: "publish",
    version: 2,
    promptId,
    creator,
    priceStroops,
    priceXlm,
    asset,
    title: payload.title ? String(payload.title) : null,
    category: payload.category ? String(payload.category) : null,
    metadataUri: payload.metadata_uri ? String(payload.metadata_uri) : null,
    contentHash: payload.content_hash ? String(payload.content_hash) : null,
  };
}

/**
 * Decodes purchase (PromptPurchased) events across schema versions.
 */
function decodePurchaseEvent(
  version: SupportedEventVersion,
  payload: any,
  raw: RawEventEnvelope,
): CanonicalPurchaseEvent {
  const promptId = String(payload.prompt_id ?? payload.id);
  const buyer = String(payload.buyer);
  const creator = String(payload.creator);

  if (!promptId || promptId === "undefined" || promptId === "null") {
    throw new Error("Missing required field: prompt_id");
  }
  if (!buyer || buyer === "undefined" || buyer === "null") {
    throw new Error("Missing required field: buyer");
  }
  if (!creator || creator === "undefined" || creator === "null") {
    throw new Error("Missing required field: creator");
  }

  const stroopsRaw = payload.price_stroops ?? payload.price;
  if (stroopsRaw === undefined || stroopsRaw === null) {
    throw new Error("Missing required field: price_stroops");
  }

  const stroopsBigInt = BigInt(stroopsRaw);
  if (stroopsBigInt < 0n) {
    throw new Error("Invalid price_stroops: value cannot be negative");
  }

  const priceStroops = stroopsBigInt.toString();
  const priceXlm = Number(stroopsBigInt) / STROOPS_PER_XLM;
  const referrer = payload.referrer ? String(payload.referrer) : null;

  if (version === 1) {
    return {
      eventType: "purchase",
      version: 1,
      promptId,
      buyer,
      creator,
      priceStroops,
      priceXlm,
      referrer,
      referralFeeStroops: null,
      referralFeeXlm: null,
      txHash: raw.transaction ? String(raw.transaction) : null,
      versionIndex: 1,
    };
  }

  let referralFeeStroops: string | null = null;
  let referralFeeXlm: number | null = null;
  if (payload.referral_fee_stroops !== undefined && payload.referral_fee_stroops !== null) {
    const refBigInt = BigInt(payload.referral_fee_stroops);
    referralFeeStroops = refBigInt.toString();
    referralFeeXlm = Number(refBigInt) / STROOPS_PER_XLM;
  }

  return {
    eventType: "purchase",
    version: 2,
    promptId,
    buyer,
    creator,
    priceStroops,
    priceXlm,
    referrer,
    referralFeeStroops,
    referralFeeXlm,
    txHash: payload.tx_hash ? String(payload.tx_hash) : (raw.transaction ?? null),
    versionIndex: payload.version_index ? Number(payload.version_index) : 1,
  };
}

/**
 * Decodes unlock (PromptUnlocked) events across schema versions.
 */
function decodeUnlockEvent(
  version: SupportedEventVersion,
  payload: any,
): CanonicalUnlockEvent {
  const promptId = String(payload.prompt_id ?? payload.id);
  const buyer = String(payload.buyer);
  const timestamp = Number(payload.timestamp);

  if (!promptId || promptId === "undefined" || promptId === "null") {
    throw new Error("Missing required field: prompt_id");
  }
  if (!buyer || buyer === "undefined" || buyer === "null") {
    throw new Error("Missing required field: buyer");
  }
  if (Number.isNaN(timestamp) || timestamp < 0) {
    throw new Error("Invalid timestamp: value must be non-negative integer");
  }

  if (version === 1) {
    return {
      eventType: "unlock",
      version: 1,
      promptId,
      buyer,
      timestamp,
      requestId: null,
      clientSession: null,
    };
  }

  return {
    eventType: "unlock",
    version: 2,
    promptId,
    buyer,
    timestamp,
    requestId: payload.request_id ? String(payload.request_id) : null,
    clientSession: payload.client_session ? String(payload.client_session) : null,
  };
}

/**
 * Deterministically decodes a raw contract event into a canonical typed representation.
 * Unparseable or unsupported events fail safely and return a dead-letter quarantine record.
 */
export function decodeContractEvent(raw: RawEventEnvelope): DecodeResult {
  const now = Date.now();

  if (!raw || typeof raw !== "object") {
    return {
      success: false,
      deadLetter: {
        eventId: "0-notx-0",
        eventType: "unknown",
        detectedVersion: null,
        reason: "CORRUPT_PAYLOAD",
        details: "Event envelope is null or non-object",
        rawPayload: raw,
        ledger: null,
        transaction: null,
        eventIndex: null,
        timestamp: now,
        recoverable: false,
      },
    };
  }

  const eventId = `${raw.ledger ?? 0}-${raw.transaction ?? "notx"}-${raw.eventIndex ?? 0}`;
  const topicTokens = Array.isArray(raw.topic) ? raw.topic : [];
  const eventType = resolveEventType(topicTokens);

  if (!eventType) {
    return {
      success: false,
      deadLetter: {
        eventId,
        eventType: String(topicTokens[0] ?? "unknown"),
        detectedVersion: null,
        reason: "UNKNOWN_EVENT_TYPE",
        details: `Topic ${String(topicTokens[0])} cannot be mapped to any known event handler`,
        rawPayload: raw.value,
        ledger: raw.ledger ?? null,
        transaction: raw.transaction ?? null,
        eventIndex: raw.eventIndex ?? null,
        timestamp: now,
        recoverable: false,
      },
    };
  }

  const detectedVersion = detectEventVersion(topicTokens, raw.value);
  if (detectedVersion === null || !isSupportedVersion(detectedVersion)) {
    return {
      success: false,
      deadLetter: {
        eventId,
        eventType,
        detectedVersion,
        reason: "UNSUPPORTED_VERSION",
        details: `Detected version ${detectedVersion} is outside supported set [${SUPPORTED_EVENT_VERSIONS.join(", ")}]`,
        rawPayload: raw.value,
        ledger: raw.ledger ?? null,
        transaction: raw.transaction ?? null,
        eventIndex: raw.eventIndex ?? null,
        timestamp: now,
        recoverable: true,
      },
    };
  }

  if (!raw.value || typeof raw.value !== "object") {
    return {
      success: false,
      deadLetter: {
        eventId,
        eventType,
        detectedVersion,
        reason: "CORRUPT_PAYLOAD",
        details: "Event payload value is missing or non-object",
        rawPayload: raw.value,
        ledger: raw.ledger ?? null,
        transaction: raw.transaction ?? null,
        eventIndex: raw.eventIndex ?? null,
        timestamp: now,
        recoverable: false,
      },
    };
  }

  try {
    let canonicalEvent: CanonicalContractEvent;
    switch (eventType) {
      case "publish":
        canonicalEvent = decodePublishEvent(detectedVersion, raw.value);
        break;
      case "purchase":
        canonicalEvent = decodePurchaseEvent(detectedVersion, raw.value, raw);
        break;
      case "unlock":
        canonicalEvent = decodeUnlockEvent(detectedVersion, raw.value);
        break;
    }

    return {
      success: true,
      event: canonicalEvent,
    };
  } catch (error: any) {
    return {
      success: false,
      deadLetter: {
        eventId,
        eventType,
        detectedVersion,
        reason: "SCHEMA_VALIDATION_FAILED",
        details: error?.message ?? "Schema validation failed",
        rawPayload: raw.value,
        ledger: raw.ledger ?? null,
        transaction: raw.transaction ?? null,
        eventIndex: raw.eventIndex ?? null,
        timestamp: now,
        recoverable: false,
      },
    };
  }
}

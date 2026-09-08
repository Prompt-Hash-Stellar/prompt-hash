# Contract Event Versioning and Compatibility Specification

This specification defines the contract event schemas, versioning conventions, decoding architecture, dead-letter quarantine mechanism, and upgrade procedures for PromptHash contract events across indexers and consumer applications.

---

## 1. Overview and Design Principles

Contract events emitted by Soroban contracts are consumed by off-chain indexers, search projection engines, analytics pipelines, and frontend clients. Schema drift or unannounced field changes break downstream consumers if defensive deserialization and compatibility suites are absent.

The PromptHash event architecture adheres to the following principles:

1. **Deterministic Decoding**: Supported schema versions map directly to strongly-typed canonical event representations.
2. **Safe Degradation (Zero Crash Guarantee)**: Unrecognized topics, unsupported schema versions, or malformed payloads never crash the indexer process. They route directly to a Dead-Letter Queue (DLQ) with structured error classifications.
3. **Additive Evolution**: New schema versions extend rather than mutate existing field semantics.
4. **Offline Fixture Verification**: Versioned JSON fixtures validate decoder behavior in continuous integration before contract or server deployments.

---

## 2. Supported Events and Schemas

PromptHash supports versioned schemas for three primary lifecycle events: `publish`, `purchase`, and `unlock`.

### 2.1 Publish (`PromptCreated`)

Emitted when a creator lists a prompt on-chain.

| Field | V1 (Legacy) | V2 (Extended) | Type | Description |
| :--- | :--- | :--- | :--- | :--- |
| `prompt_id` | Required | Required | `u64` / `string` | Unique prompt identifier |
| `creator` | Required | Required | `Address` / `string` | Stellar address of prompt author |
| `price_stroops` | Required | Required | `i128` / `string` | Base listing price in stroops (1 XLM = 10^7 stroops) |
| `asset` | Required | Required | `Address` / `string` | Payment token contract identifier |
| `schema_version` | Omitted (implied `1`) | Required (`2`) | `u32` / `number` | Explicit schema version identifier |
| `title` | Not present | Optional | `string` | Plain-text prompt listing title |
| `category` | Not present | Optional | `string` | Classification category |
| `metadata_uri` | Not present | Optional | `string` | IPFS or Arweave metadata URI |
| `content_hash` | Not present | Optional | `string` | Cryptographic hash of encrypted prompt payload |

### 2.2 Purchase (`PromptPurchased`)

Emitted when a buyer completes payment and receives access rights.

| Field | V1 (Legacy) | V2 (Extended) | Type | Description |
| :--- | :--- | :--- | :--- | :--- |
| `prompt_id` | Required | Required | `u64` / `string` | Unique prompt identifier |
| `buyer` | Required | Required | `Address` / `string` | Stellar address of purchasing account |
| `creator` | Required | Required | `Address` / `string` | Stellar address of prompt author |
| `price_stroops` | Required | Required | `i128` / `string` | Payment amount in stroops |
| `referrer` | Optional | Optional | `Address` / `string` | Optional affiliate address |
| `schema_version` | Omitted (implied `1`) | Required (`2`) | `u32` / `number` | Explicit schema version identifier |
| `referral_fee_stroops` | Not present | Optional | `i128` / `string` | Stroop amount paid to affiliate |
| `tx_hash` | Omitted from value | Optional | `string` | On-chain transaction hash |
| `version_index` | Implied `1` | Optional (`number`) | `u32` / `number` | Version iteration purchased |

### 2.3 Unlock (`PromptUnlocked`)

Emitted when an authorized buyer unlocks prompt content via on-chain access verification.

| Field | V1 (Baseline) | V2 (Extended) | Type | Description |
| :--- | :--- | :--- | :--- | :--- |
| `prompt_id` | Required | Required | `u64` / `string` | Unique prompt identifier |
| `buyer` | Required | Required | `Address` / `string` | Verified buyer executing the unlock |
| `timestamp` | Required | Required | `u64` / `number` | Unix timestamp of unlock operation |
| `schema_version` | Omitted (implied `1`) | Required (`2`) | `u32` / `number` | Explicit schema version identifier |
| `request_id` | Not present | Optional | `string` | Correlated client request identifier |
| `client_session` | Not present | Optional | `string` | Authenticated session token hash |

---

## 3. Decoder and Dead-Letter Queue Architecture

### 3.1 Version Detection Logic

The decoder detects schema version using a two-stage fallback:

1. **Topic Token Inspection**: If the topic array contains a token formatted as `v[0-9]+` (e.g. `v2`), that version integer is selected.
2. **Payload Inspection**: If the payload object contains `schema_version` or `version`, that numeric value is extracted.
3. **Default Fallback**: If no version indicator is detected on a recognized topic, version defaults to `1`.

### 3.2 Error Classification Matrix

When an event cannot be converted into a canonical representation, it generates a `DeadLetterRecord` with one of four classifications:

| Reason Code | Condition | Recoverable | Action |
| :--- | :--- | :--- | :--- |
| `UNKNOWN_EVENT_TYPE` | Topic does not match any registered contract event handler | False | Quarantined; maintainers review if new contract module was deployed |
| `UNSUPPORTED_VERSION` | Event specifies schema version outside `SUPPORTED_EVENT_VERSIONS` (e.g. `99`) | True | Quarantined; replayable after server decoder package upgrade |
| `SCHEMA_VALIDATION_FAILED` | Missing mandatory fields (e.g. missing `creator`) or illegal values (e.g. negative prices) | False | Quarantined; flagged for contract bug investigation |
| `CORRUPT_PAYLOAD` | Event envelope is null, non-object, or corrupted binary payload | False | Quarantined; transport or RPC layer failure |

### 3.3 Dead-Letter Storage and Access

Quarantined events are stored through `DeadLetterQueueService`:

- **Primary Persistence**: Stored in MongoDB collection `deadletterevents` with indices on `reason`, `eventType`, `ledger`, and `transaction`.
- **In-Memory Fallback**: Buffered in an in-memory ring buffer (default capacity 1,000 items) when database connectivity is offline.
- **Inspection Methods**:
  - `DeadLetterQueueService.getDeadLetterRecords(filter)`: Queries quarantined events by reason or type.
  - `DeadLetterQueueService.getDeadLetterCount()`: Returns total volume of quarantined events.
  - `DeadLetterQueueService.clearDeadLetterRecords()`: Purges records after resolution.

---

## 4. Test Fixtures and Verification Suite

Event fixtures reside in `contracts/fixtures/events/` and `server/src/fixtures/events/`.

### 4.1 Manifest Structure (`manifest.json`)

The manifest defines the authoritative catalog of test fixtures:

```json
{
  "name": "prompt-contract-event-fixtures",
  "version": "1.0.0",
  "supportedEventTypes": ["publish", "purchase", "unlock"],
  "supportedVersions": [1, 2],
  "fixtures": {
    "supported": [
      { "eventType": "publish", "version": 1, "path": "publish.v1.json" },
      { "eventType": "publish", "version": 2, "path": "publish.v2.json" },
      { "eventType": "purchase", "version": 1, "path": "purchase.v1.json" },
      { "eventType": "purchase", "version": 2, "path": "purchase.v2.json" },
      { "eventType": "unlock", "version": 1, "path": "unlock.v1.json" },
      { "eventType": "unlock", "version": 2, "path": "unlock.v2.json" }
    ],
    "unsupported": [
      { "name": "unknown_topic", "path": "unsupported.unknown_topic.json" },
      { "name": "invalid_version", "path": "unsupported.invalid_version.json" },
      { "name": "malformed_payload", "path": "unsupported.malformed_payload.json" }
    ]
  }
}
```

### 4.2 Running Compatibility Suites

Run Rust contract tests:
```bash
cargo test
```

Run TypeScript decoder and compatibility suites:
```bash
npm --prefix server test -- eventDecoder.test.ts
```

---

## 5. Event Upgrade Runbook

Follow this protocol when introducing a new event version `v(N+1)` to production.

### Phase 1: Off-Chain Consumer Preparation

1. **Update Types**: Add `N+1` to `SupportedEventVersion` in `server/src/types/eventVersioning.ts`.
2. **Define Canonical Mappings**: Extend canonical event interfaces with any new non-breaking fields.
3. **Implement Version Decoder**: Add `decode<EventType>V<N+1>` branch in `server/src/services/eventDecoder.ts`.
4. **Create Versioned Fixture**:
   - Write `<eventType>.v<N+1>.json` in `contracts/fixtures/events/` and `server/src/fixtures/events/`.
   - Update `manifest.json` with the new version entry.
5. **Verify Tests**: Confirm all existing and new fixtures pass `npm --prefix server test`.
6. **Deploy Server Services**: Deploy the updated server and indexer services before contract modifications are published.

### Phase 2: On-Chain Contract Updates

1. **Update Rust Event Structures**: Add new event fields in `contracts/prompt-hash/src/events.rs`.
2. **Emit New Event**: Call updated event emitter within the corresponding contract entrypoint in `contracts/prompt-hash/src/contract.rs`.
3. **Verify Contract Tests**: Run `cargo test` to ensure emission counts and payload topics match expected behavior.
4. **Deploy Contract**: Deploy updated contract WASM to Stellar testnet/mainnet.

### Phase 3: Post-Deployment Quarantine Inspection

1. Query `DeadLetterEvent` records for any newly generated items.
2. Confirm that `UNSUPPORTED_VERSION` records for version `N+1` have ceased.
3. If pre-upgrade events were quarantined under `UNSUPPORTED_VERSION`, execute re-indexing from the quarantined ledger height:
   ```bash
   npm --prefix server run reindex -- --from-ledger <ledger_height>
   ```
4. Verify indexer checkpoints and projection health:
   ```bash
   curl -s http://localhost:5001/api/health
   ```

export type StreamId = { network: string; contract: string };

export type RawIndexerEvent = StreamId & {
  ledger: number;
  transaction: string;
  eventIndex: number;
  schemaIdentity: string;
  topic: string;
  value: unknown;
};

export type StoredRawEvent = RawIndexerEvent & { id: string };
export type EventPage = { events: RawIndexerEvent[]; cursor?: string | null };
export type EventProvider = { getEvents(input: StreamId & { startLedger: number; endLedger: number; cursor?: string }): Promise<EventPage> };
export type Projection = { apply(event: StoredRawEvent): Promise<void>; reset?(): Promise<void> };
export type Lease = { streamKey: string; ownerId: string; fencingToken: number; expiresAt: number };

export interface IndexerStore {
  acquireLease(streamKey: string, ownerId: string, ttlMs: number, now?: number): Promise<Lease | null>;
  renewLease(streamKey: string, ownerId: string, fencingToken: number, ttlMs: number, now?: number): Promise<Lease | null>;
  validateLease(streamKey: string, ownerId: string, fencingToken: number, now?: number): Promise<boolean>;
  persistRawEvent(event: RawIndexerEvent): Promise<StoredRawEvent>;
  hasProjected(eventId: string): Promise<boolean>;
  markProjected(eventId: string): Promise<void>;
  quarantine(event: StoredRawEvent, error: unknown): Promise<void>;
  getRawEvents(stream: StreamId, fromLedger?: number, toLedger?: number): Promise<StoredRawEvent[]>;
  getSourceCheckpoint(streamKey: string): Promise<number>;
  setSourceCheckpoint(streamKey: string, ledger: number): Promise<void>;
  getRawCheckpoint(streamKey: string): Promise<number>;
  setRawCheckpoint(streamKey: string, ledger: number): Promise<void>;
  getProjectionCheckpoint(streamKey: string): Promise<number>;
  setProjectionCheckpoint(streamKey: string, ledger: number): Promise<void>;
  health(streamKey: string): Promise<IndexerHealth>;
}

export type IndexerHealth = {
  sourceCheckpoint: number;
  rawEventCheckpoint: number;
  projectionCheckpoint: number;
  quarantinedFailures: number;
  lease?: Lease;
};

export function streamKey(stream: StreamId) {
  assertValidStream(stream);
  return `${stream.network}:${stream.contract}`;
}

export function eventId(event: RawIndexerEvent) {
  return [event.network, event.contract, event.ledger, event.transaction, event.eventIndex, event.schemaIdentity].join(":");
}

export function assertValidStream(stream: StreamId) {
  if (!stream.network.trim()) throw new Error("Indexer stream requires a network");
  if (!stream.contract.trim()) throw new Error("Indexer stream requires a contract");
}

export class InMemoryIndexerStore implements IndexerStore {
  private leases = new Map<string, Lease>();
  private raw = new Map<string, StoredRawEvent>();
  private projected = new Set<string>();
  private quarantined = new Map<string, unknown>();
  private sourceCheckpoints = new Map<string, number>();
  private rawCheckpoints = new Map<string, number>();
  private projectionCheckpoints = new Map<string, number>();
  private nextFence = 1;

  async acquireLease(streamKey: string, ownerId: string, ttlMs: number, now = Date.now()) {
    const existing = this.leases.get(streamKey);
    if (existing && existing.expiresAt > now && existing.ownerId !== ownerId) return null;
    const lease = { streamKey, ownerId, fencingToken: this.nextFence++, expiresAt: now + ttlMs };
    this.leases.set(streamKey, lease);
    return lease;
  }

  async renewLease(streamKey: string, ownerId: string, fencingToken: number, ttlMs: number, now = Date.now()) {
    if (!(await this.validateLease(streamKey, ownerId, fencingToken, now))) return null;
    const lease = { streamKey, ownerId, fencingToken, expiresAt: now + ttlMs };
    this.leases.set(streamKey, lease);
    return lease;
  }

  async validateLease(streamKey: string, ownerId: string, fencingToken: number, now = Date.now()) {
    const lease = this.leases.get(streamKey);
    return !!lease && lease.ownerId === ownerId && lease.fencingToken === fencingToken && lease.expiresAt > now;
  }

  async persistRawEvent(event: RawIndexerEvent) {
    const id = eventId(event);
    const stored = this.raw.get(id) ?? { ...event, id };
    this.raw.set(id, stored);
    return stored;
  }

  async hasProjected(eventId: string) { return this.projected.has(eventId); }
  async markProjected(eventId: string) { this.projected.add(eventId); }
  async quarantine(event: StoredRawEvent, error: unknown) { this.quarantined.set(event.id, error); }

  async getRawEvents(stream: StreamId, fromLedger = 0, toLedger = Number.MAX_SAFE_INTEGER) {
    return [...this.raw.values()]
      .filter((e) => e.network === stream.network && e.contract === stream.contract && e.ledger >= fromLedger && e.ledger <= toLedger)
      .sort(compareEvents);
  }

  async getSourceCheckpoint(key: string) { return this.sourceCheckpoints.get(key) ?? 0; }
  async setSourceCheckpoint(key: string, ledger: number) { this.sourceCheckpoints.set(key, ledger); }
  async getRawCheckpoint(key: string) { return this.rawCheckpoints.get(key) ?? 0; }
  async setRawCheckpoint(key: string, ledger: number) { this.rawCheckpoints.set(key, ledger); }
  async getProjectionCheckpoint(key: string) { return this.projectionCheckpoints.get(key) ?? 0; }
  async setProjectionCheckpoint(key: string, ledger: number) { this.projectionCheckpoints.set(key, ledger); }

  async health(key: string) {
    return {
      sourceCheckpoint: await this.getSourceCheckpoint(key),
      rawEventCheckpoint: await this.getRawCheckpoint(key),
      projectionCheckpoint: await this.getProjectionCheckpoint(key),
      quarantinedFailures: this.quarantined.size,
      lease: this.leases.get(key),
    };
  }
}

export async function indexRange(input: {
  stream: StreamId;
  provider: EventProvider;
  store: IndexerStore;
  projection: Projection;
  ownerId: string;
  startLedger: number;
  endLedger: number;
  leaseTtlMs?: number;
  providerRetries?: number;
}) {
  const key = streamKey(input.stream);
  const lease = await input.store.acquireLease(key, input.ownerId, input.leaseTtlMs ?? 30_000);
  if (!lease) throw new Error(`Indexer stream ${key} is leased by another worker`);

  let cursor: string | undefined;
  let maxLedger = input.startLedger - 1;
  do {
    if (!(await input.store.validateLease(key, input.ownerId, lease.fencingToken))) throw new Error("Indexer lease fence lost");
    const page = await fetchPageWithRetry(input.provider, { ...input.stream, startLedger: input.startLedger, endLedger: input.endLedger, cursor }, input.providerRetries ?? 2);
    for (const event of page.events) {
      assertEventBelongsToStream(input.stream, event);
      const stored = await input.store.persistRawEvent(event);
      maxLedger = Math.max(maxLedger, stored.ledger);
      await projectOnce(stored, input.store, input.projection, key);
    }
    cursor = page.cursor ?? undefined;
    await input.store.renewLease(key, input.ownerId, lease.fencingToken, input.leaseTtlMs ?? 30_000);
  } while (cursor);

  await input.store.setRawCheckpoint(key, Math.max(await input.store.getRawCheckpoint(key), maxLedger));
  await input.store.setSourceCheckpoint(key, input.endLedger);
  return input.store.health(key);
}

export async function rebuildProjection(stream: StreamId, store: IndexerStore, projection: Projection, fromLedger = 0, toLedger = Number.MAX_SAFE_INTEGER) {
  const key = streamKey(stream);
  await projection.reset?.();
  for (const event of await store.getRawEvents(stream, fromLedger, toLedger)) {
    await projection.apply(event);
    await store.markProjected(`rebuild:${event.id}`);
    await store.setProjectionCheckpoint(key, event.ledger);
  }
}

async function fetchPageWithRetry(provider: EventProvider, request: StreamId & { startLedger: number; endLedger: number; cursor?: string }, retries: number) {
  let attempt = 0;
  for (;;) {
    try {
      return await provider.getEvents(request);
    } catch (error) {
      if (attempt++ >= retries) throw error;
    }
  }
}

async function projectOnce(event: StoredRawEvent, store: IndexerStore, projection: Projection, key: string) {
  if (await store.hasProjected(event.id)) return;
  try {
    await projection.apply(event);
    await store.markProjected(event.id);
    await store.setProjectionCheckpoint(key, event.ledger);
  } catch (error) {
    await store.quarantine(event, error);
  }
}

function assertEventBelongsToStream(stream: StreamId, event: RawIndexerEvent) {
  if (event.network !== stream.network || event.contract !== stream.contract) {
    throw new Error(`Event stream mismatch: expected ${stream.network}:${stream.contract}`);
  }
}

function compareEvents(a: StoredRawEvent, b: StoredRawEvent) {
  return a.ledger - b.ledger || a.transaction.localeCompare(b.transaction) || a.eventIndex - b.eventIndex;
}

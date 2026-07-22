import { InMemoryIndexerStore, RawIndexerEvent, indexRange, rebuildProjection, streamKey, type EventProvider, type Projection } from "./indexerPipeline";

const stream = { network: "testnet", contract: "C123" };
const evt = (ledger: number, eventIndex = 0, topic = "sale", transaction = `tx-${ledger}`): RawIndexerEvent => ({
  ...stream,
  ledger,
  transaction,
  eventIndex,
  schemaIdentity: "prompt-hash:v1",
  topic,
  value: { amount: 1 },
});

class CountingProjection implements Projection {
  sales = 0;
  seen: string[] = [];
  failOn?: number;
  async apply(event: { id: string; ledger: number }) {
    if (this.failOn === event.ledger) throw new Error("projection failed");
    this.sales += 1;
    this.seen.push(event.id);
  }
  async reset() { this.sales = 0; this.seen = []; }
}

const pagedProvider = (pages: { events: RawIndexerEvent[]; cursor?: string | null }[]): EventProvider => ({
  async getEvents({ cursor }) {
    const index = cursor ? Number(cursor) : 0;
    return pages[index];
  },
});

describe("indexerPipeline", () => {
  it("follows multi-page continuations before checkpoint advancement", async () => {
    const store = new InMemoryIndexerStore();
    const projection = new CountingProjection();
    const health = await indexRange({ stream, store, projection, ownerId: "a", startLedger: 1, endLedger: 3, provider: pagedProvider([
      { events: [evt(1)], cursor: "1" },
      { events: [evt(2), evt(3)], cursor: null },
    ]) });
    expect(projection.seen).toHaveLength(3);
    expect(health.sourceCheckpoint).toBe(3);
    expect(health.rawEventCheckpoint).toBe(3);
  });

  it("quarantines failure in the middle of an event page without losing raw events", async () => {
    const store = new InMemoryIndexerStore();
    const projection = new CountingProjection();
    projection.failOn = 2;
    const health = await indexRange({ stream, store, projection, ownerId: "a", startLedger: 1, endLedger: 3, provider: pagedProvider([{ events: [evt(1), evt(2), evt(3)] }]) });
    expect(await store.getRawEvents(stream)).toHaveLength(3);
    expect(projection.sales).toBe(2);
    expect(health.quarantinedFailures).toBe(1);
  });

  it("recovers from crash before and after raw-event persistence", async () => {
    const store = new InMemoryIndexerStore();
    const projection = new CountingProjection();
    await store.persistRawEvent(evt(1));
    await indexRange({ stream, store, projection, ownerId: "a", startLedger: 1, endLedger: 2, provider: pagedProvider([{ events: [evt(1), evt(2)] }]) });
    await indexRange({ stream, store, projection, ownerId: "a", startLedger: 1, endLedger: 2, provider: pagedProvider([{ events: [evt(1), evt(2)] }]) });
    expect(await store.getRawEvents(stream)).toHaveLength(2);
    expect(projection.sales).toBe(2);
  });

  it("allows only one lease owner in a worker race and supports expiration", async () => {
    const store = new InMemoryIndexerStore();
    const key = streamKey(stream);
    const first = await store.acquireLease(key, "worker-a", 100, 1_000);
    const second = await store.acquireLease(key, "worker-b", 100, 1_001);
    const expired = await store.acquireLease(key, "worker-b", 100, 1_101);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(expired?.ownerId).toBe("worker-b");
    expect(await store.validateLease(key, "worker-a", first!.fencingToken, 1_102)).toBe(false);
  });

  it("retries transient RPC/provider failures", async () => {
    const store = new InMemoryIndexerStore();
    const projection = new CountingProjection();
    let attempts = 0;
    await indexRange({
      stream,
      store,
      projection,
      ownerId: "a",
      startLedger: 1,
      endLedger: 1,
      provider: { getEvents: async () => attempts++ === 0 ? Promise.reject(new Error("timeout")) : { events: [evt(1)] } },
    });
    expect(attempts).toBe(2);
    expect(projection.sales).toBe(1);
  });

  it("does not advance checkpoints when the provider retry still fails", async () => {
    const store = new InMemoryIndexerStore();
    const projection = new CountingProjection();
    await expect(indexRange({ stream, store, projection, ownerId: "a", startLedger: 1, endLedger: 2, provider: { getEvents: async () => { throw new Error("rpc unavailable"); } } })).rejects.toThrow("rpc unavailable");
    expect(await store.health(streamKey(stream))).toMatchObject({ sourceCheckpoint: 0, rawEventCheckpoint: 0, projectionCheckpoint: 0 });
  });

  it("supports bounded historical backfill", async () => {
    const store = new InMemoryIndexerStore();
    const projection = new CountingProjection();
    await indexRange({ stream, store, projection, ownerId: "a", startLedger: 10, endLedger: 12, provider: pagedProvider([{ events: [evt(10), evt(11), evt(12)] }]) });
    expect((await store.getRawEvents(stream, 11, 12)).map((event) => event.ledger)).toEqual([11, 12]);
  });

  it("rebuilds projections to the same state as incremental indexing", async () => {
    const store = new InMemoryIndexerStore();
    const incremental = new CountingProjection();
    await indexRange({ stream, store, projection: incremental, ownerId: "a", startLedger: 1, endLedger: 3, provider: pagedProvider([{ events: [evt(1), evt(2), evt(3)] }]) });
    const rebuilt = new CountingProjection();
    await rebuildProjection(stream, store, rebuilt);
    expect(rebuilt.sales).toBe(incremental.sales);
    expect(rebuilt.seen).toEqual(incremental.seen);
  });

  it("ignores duplicate event delivery for idempotent projections", async () => {
    const store = new InMemoryIndexerStore();
    const projection = new CountingProjection();
    await indexRange({ stream, store, projection, ownerId: "a", startLedger: 1, endLedger: 1, provider: pagedProvider([{ events: [evt(1), evt(1)] }]) });
    expect(projection.sales).toBe(1);
  });

  it("recovers checkpoints after restart from persisted raw events", async () => {
    const store = new InMemoryIndexerStore();
    await store.persistRawEvent(evt(1));
    await store.setRawCheckpoint(streamKey(stream), 1);
    const projection = new CountingProjection();
    await rebuildProjection(stream, store, projection);
    expect((await store.health(streamKey(stream))).projectionCheckpoint).toBe(1);
  });

  it("rejects mismatched streams", async () => {
    const store = new InMemoryIndexerStore();
    const projection = new CountingProjection();
    await expect(indexRange({ stream, store, projection, ownerId: "a", startLedger: 1, endLedger: 1, provider: pagedProvider([{ events: [{ ...evt(1), contract: "OTHER" }] }]) })).rejects.toThrow("Event stream mismatch");
  });
});

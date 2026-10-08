import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { baseConfig, startServer, type Harness } from '../gateway/testSupport.js';
import { TestClient, waitUntil } from '../transport/clusterSupport.js';
import { DocumentStore } from './documentStore.js';
import { Persistence, type PersistenceOptions } from './persistence.js';
import { startTestPostgres, type TestPostgres } from './testPostgres.js';

const logger = pino({ level: 'silent' });

/** Lets a test hold individual store operations open, to prove what does and
 * doesn't wait on the database. */
class GatedStore extends DocumentStore {
  appendGate: Promise<void> | null = null;
  loadGate: Promise<void> | null = null;
  failLoad = false;

  override async appendOps(id: string, payloads: Uint8Array[], origin: string): Promise<void> {
    await this.appendGate;
    return super.appendOps(id, payloads, origin);
  }

  override async load(id: string): ReturnType<DocumentStore['load']> {
    await this.loadGate;
    if (this.failLoad) throw new Error('simulated read failure');
    return super.load(id);
  }
}

/** The same canonical form for both sides of a comparison: re-encoding
 * through a fresh doc removes differences that come only from how a
 * particular doc happened to split or merge its internal structs. */
function canonical(doc: Y.Doc): Uint8Array {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return Y.encodeStateAsUpdate(copy);
}

describe('Persistence (real Postgres)', () => {
  let pg: TestPostgres;
  let store: GatedStore;
  let harnesses: Harness[] = [];
  let clients: TestClient[] = [];
  let roomCounter = 0;
  const nextRoom = () => `persist-room-${++roomCounter}`;

  beforeAll(async () => {
    pg = await startTestPostgres();
  }, 180_000);

  afterAll(async () => {
    await pg.stop();
  });

  beforeEach(async () => {
    await pg.reset();
    store = new GatedStore(pg.pool);
  });

  afterEach(async () => {
    const toClose = clients;
    const toStop = harnesses;
    clients = [];
    harnesses = [];
    for (const client of toClose) client.close();
    for (const harness of toStop) await harness.close().catch(() => undefined);
  });

  async function boot(overrides: Partial<PersistenceOptions> = {}): Promise<{ harness: Harness; persistence: Persistence }> {
    const persistence = new Persistence({
      store,
      instanceId: 'solo',
      logger,
      flushIntervalMs: 20,
      snapshotEveryOps: 100_000,
      snapshotIntervalMs: 600_000,
      retentionVersions: 4,
      maxPendingOps: 2000,
      maxPendingBytes: 8 * 1024 * 1024,
      recoveryTimeoutMs: 3000,
      ...overrides,
    });
    const harness = await startServer(baseConfig(), { persistence });
    harnesses.push(harness);
    return { harness, persistence };
  }

  async function join(harness: Harness, room: string): Promise<TestClient> {
    const client = new TestClient(harness.url, room);
    clients.push(client);
    await client.ready;
    return client;
  }

  /** Waits until the server demonstrably holds the author's text, by having
   * a second client read it back. Without this a test can shut the server
   * down while the author's edits are still in flight on the socket, and
   * then be testing a message that never arrived. */
  async function delivered(harness: Harness, room: string, text: string): Promise<void> {
    const observer = await join(harness, room);
    await waitUntil(() => observer.text === text, 5000, 'the server to hold the author\'s edits');
    observer.close();
  }

  async function restart(current: { harness: Harness }, clientsToDrop: TestClient[]): Promise<void> {
    for (const client of clientsToDrop) client.close();
    await current.harness.close();
    harnesses = harnesses.filter((h) => h !== current.harness);
  }

  /** Types a few edits and a deletion, then returns the final text. */
  function edit(client: TestClient): string {
    client.insert(0, 'The quick brown fox ');
    client.insert(client.text.length, 'jumps over the lazy dog.');
    client.delete(4, 6); // "quick "
    client.insert(client.text.length, ' Twice.');
    return client.text;
  }

  it('recovers a document after a graceful restart with identical state', async () => {
    const room = nextRoom();
    const first = await boot();
    const author = await join(first.harness, room);
    const expectedText = edit(author);
    const originalState = canonical(author.doc);
    await delivered(first.harness, room, expectedText);

    await restart(first, [author]);
    const second = await boot();
    const reader = await join(second.harness, room);

    expect(reader.text).toBe(expectedText);
    expect(Array.from(Y.encodeStateVector(reader.doc))).toEqual(Array.from(Y.encodeStateVector(author.doc)));
    expect(Array.from(canonical(reader.doc))).toEqual(Array.from(originalState));
  });

  it('recovers from the op log alone when the instance dies before any snapshot exists', async () => {
    const room = nextRoom();
    const first = await boot();
    const author = await join(first.harness, room);
    const expectedText = edit(author);
    await delivered(first.harness, room, expectedText);

    await waitUntil(() => first.persistence.stats.opsWritten > 0 && first.persistence.pendingOps(room) === 0, 5000, 'ops flushed');
    first.persistence.crash(); // no final flush, no snapshot
    expect((await store.readSnapshot(room))!.snapshotVersion).toBe(0);
    await restart(first, [author]);

    const second = await boot();
    const reader = await join(second.harness, room);
    expect(reader.text).toBe(expectedText);
  });

  it('combines a snapshot with the ops written after it', async () => {
    const room = nextRoom();
    const first = await boot({ snapshotEveryOps: 3, retentionVersions: 100 });
    const author = await join(first.harness, room);
    for (let i = 0; i < 12; i++) {
      author.insert(author.text.length, `line ${i}\n`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const expectedText = author.text;
    await delivered(first.harness, room, expectedText);
    await waitUntil(() => first.persistence.stats.snapshots >= 2 && first.persistence.pendingOps(room) === 0, 8000, 'snapshots and flush');
    first.persistence.crash();
    expect((await store.readSnapshot(room))!.snapshotVersion).toBeGreaterThanOrEqual(2);
    expect(await store.opCount(room)).toBeGreaterThan(0); // retained, so replay has something after the snapshot
    await restart(first, [author]);

    const second = await boot();
    const reader = await join(second.harness, room);
    expect(reader.text).toBe(expectedText);
  });

  it('compaction removes old ops without losing any data', async () => {
    const room = nextRoom();
    const first = await boot({ snapshotEveryOps: 4, retentionVersions: 1 });
    const author = await join(first.harness, room);
    for (let i = 0; i < 80; i++) {
      author.insert(author.text.length, `entry-${i};`);
      if (i % 9 === 4) author.delete(Math.max(0, author.text.length - 3), 2);
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    const expectedText = author.text;
    await delivered(first.harness, room, expectedText);
    await waitUntil(() => first.persistence.stats.opsCompacted > 0, 8000, 'compaction to run');
    const writes = first.persistence.stats.flushes;

    await restart(first, [author]);
    expect(await store.opCount(room), 'log is shorter than everything written').toBeLessThan(writes);
    expect((await store.readSnapshot(room))!.snapshotVersion).toBeGreaterThan(1);

    const second = await boot();
    const reader = await join(second.harness, room);
    expect(reader.text).toBe(expectedText);
    expect(Array.from(Y.encodeStateVector(reader.doc))).toEqual(Array.from(Y.encodeStateVector(author.doc)));
  });

  it('keeps Postgres off the edit path: edits reach other clients while every write is stalled', async () => {
    const room = nextRoom();
    let release!: () => void;
    store.appendGate = new Promise<void>((resolve) => (release = resolve));
    const instance = await boot();
    const writer = await join(instance.harness, room);
    const reader = await join(instance.harness, room);

    writer.insert(0, 'visible while postgres writes are hung');
    await waitUntil(() => reader.text === 'visible while postgres writes are hung', 3000, 'edit to reach the other client');
    expect(instance.persistence.stats.opsWritten).toBe(0); // and nothing was written yet

    release();
    await waitUntil(() => instance.persistence.stats.opsWritten > 0, 5000, 'the stalled write to complete');
  });

  it('opens a room without waiting forever on a hung database, then merges the persisted state in when it arrives', async () => {
    const room = nextRoom();
    const first = await boot();
    const author = await join(first.harness, room);
    author.insert(0, 'persisted earlier');
    await delivered(first.harness, room, 'persisted earlier');
    await restart(first, [author]);

    let release!: () => void;
    store.loadGate = new Promise<void>((resolve) => (release = resolve));
    const second = await boot({ recoveryTimeoutMs: 300 });
    const reader = await join(second.harness, room); // returns despite the stalled read
    expect(reader.text).toBe('');
    reader.insert(0, 'typed meanwhile. ');

    release();
    await waitUntil(() => reader.text.includes('persisted earlier') && reader.text.includes('typed meanwhile.'), 5000, 'late recovery to merge');
  });

  it('can lose the most recent unflushed edits in a crash (the documented durability window)', async () => {
    const room = nextRoom();
    const first = await boot({ flushIntervalMs: 600_000 }); // effectively never flushes on its own
    const author = await join(first.harness, room);
    author.insert(0, 'typed just before the crash');
    await delivered(first.harness, room, 'typed just before the crash');
    await waitUntil(() => first.persistence.pendingOps(room) > 0, 3000, 'edit to be buffered');

    first.persistence.crash();
    await restart(first, [author]);
    const second = await boot();
    const reader = await join(second.harness, room);
    expect(reader.text).toBe('');
  });

  it('sheds an overflowing buffer without losing content: the forced snapshot carries it', async () => {
    const room = nextRoom();
    let release!: () => void;
    store.appendGate = new Promise<void>((resolve) => (release = resolve));
    const first = await boot({ maxPendingOps: 3 });
    const author = await join(first.harness, room);
    for (let i = 0; i < 20; i++) author.insert(author.text.length, `[${i}]`);
    const expectedText = author.text;
    await delivered(first.harness, room, expectedText);

    await waitUntil(() => first.persistence.stats.opsDropped > 0, 3000, 'the buffer to overflow');
    await waitUntil(() => first.persistence.stats.snapshots > 0, 5000, 'the forced snapshot (flush is still stalled)');
    release();
    await restart(first, [author]);

    const second = await boot();
    const reader = await join(second.harness, room);
    expect(reader.text).toBe(expectedText);
  });

  it('never shrinks stored state: an instance that recovered nothing can only add to the snapshot', async () => {
    const room = nextRoom();
    // Retention 0 compacts the op log away at the first snapshot, so the
    // original content lives ONLY in the snapshot. Otherwise the retained
    // ops would mask a snapshot that overwrote instead of merging.
    const first = await boot({ retentionVersions: 0 });
    const author = await join(first.harness, room);
    author.insert(0, 'original content. ');
    await delivered(first.harness, room, 'original content. ');
    await restart(first, [author]);
    expect(await store.opCount(room), 'the content must be in the snapshot alone').toBe(0);

    store.failLoad = true; // the next instance cannot read what is stored
    const second = await boot();
    const newcomer = await join(second.harness, room);
    expect(newcomer.text).toBe('');
    newcomer.insert(0, 'added by the blind instance.');
    await delivered(second.harness, room, 'added by the blind instance.');
    await restart(second, [newcomer]);

    store.failLoad = false;
    const third = await boot();
    const reader = await join(third.harness, room);
    expect(reader.text).toContain('original content.');
    expect(reader.text).toContain('added by the blind instance.');
  });

  it('skips an unreadable op row instead of refusing to open the document', async () => {
    const room = nextRoom();
    const first = await boot();
    const author = await join(first.harness, room);
    author.insert(0, 'the readable part');
    await delivered(first.harness, room, 'the readable part');
    await waitUntil(() => first.persistence.stats.opsWritten > 0, 5000, 'op written');
    first.persistence.crash();
    await restart(first, [author]);
    await pg.pool.query(
      "INSERT INTO document_ops (doc_id, base_version, payload, origin_instance) VALUES ($1, 0, '\\xdeadbeef', 'corrupt')",
      [room],
    );

    const second = await boot();
    const reader = await join(second.harness, room);
    expect(reader.text).toBe('the readable part');
  });
});

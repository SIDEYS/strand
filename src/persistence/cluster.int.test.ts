import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TestClient,
  mulberry32,
  startInstance,
  waitUntil,
  type Instance,
} from '../transport/clusterSupport.js';
import { startTestRedis, type TestRedis } from '../transport/testRedis.js';
import { DocumentStore } from './documentStore.js';
import { startTestPostgres, type TestPostgres } from './testPostgres.js';

let redis: TestRedis;
let pg: TestPostgres;
let admin: Redis;
let store: DocumentStore;
let instances: Instance[] = [];
let clients: TestClient[] = [];
let roomCounter = 0;
const nextRoom = () => `cluster-persist-${++roomCounter}`;

beforeAll(async () => {
  [redis, pg] = await Promise.all([startTestRedis(), startTestPostgres()]);
  admin = new Redis(redis.url);
  store = new DocumentStore(pg.pool);
}, 180_000);

afterAll(async () => {
  admin.disconnect();
  await Promise.all([redis.stop(), pg.stop()]);
});

beforeEach(async () => {
  await Promise.all([admin.flushall(), pg.reset()]);
});

afterEach(async () => {
  const toClose = clients;
  const toStop = instances;
  clients = [];
  instances = [];
  for (const client of toClose) client.close();
  for (const instance of toStop) await instance.stop();
});

async function start(id: string, config = {}, random?: () => number): Promise<Instance> {
  const instance = await startInstance(redis.url, id, config, random, { pool: pg.pool });
  instances.push(instance);
  return instance;
}

async function join(instance: Instance, room: string): Promise<TestClient> {
  const client = new TestClient(instance.url, room);
  clients.push(client);
  await client.ready;
  return client;
}

/** What a document would look like if rebuilt from the given rows only. */
function replay(payloads: Uint8Array[]): string {
  const doc = new Y.Doc();
  for (const payload of payloads) Y.applyUpdate(doc, payload);
  return doc.getText('content').toJSON();
}

async function opsFrom(room: string, origin: string): Promise<Uint8Array[]> {
  const rows = await pg.pool.query<{ payload: Buffer }>(
    'SELECT payload FROM document_ops WHERE doc_id = $1 AND origin_instance = $2',
    [room, origin],
  );
  return rows.rows.map((r) => new Uint8Array(r.payload));
}

describe('persistence across instances (real Redis + Postgres)', () => {
  it('logs each edit once, from the instance whose client made it, and never a peer\'s', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const a = await join(one, room);
    const b = await join(two, room);

    a.insert(0, 'alpha ');
    b.insert(0, 'beta ');
    await waitUntil(() => a.text === b.text && a.text.length === 11, 5000, 'both edits to replicate');
    await waitUntil(
      () => one.persistence!.stats.opsWritten > 0 && two.persistence!.stats.opsWritten > 0,
      5000,
      'both instances to write their own ops',
    );
    await new Promise((resolve) => setTimeout(resolve, 200)); // room for a (wrong) second write to show up

    // Rows by 'one' rebuild exactly A's typing; rows by 'two' exactly B's.
    // If either instance had also logged what it received, each set would
    // contain the other's text.
    expect(replay(await opsFrom(room, 'one'))).toBe('alpha ');
    expect(replay(await opsFrom(room, 'two'))).toBe('beta ');
    expect(await store.opCount(room)).toBe(one.persistence!.stats.flushes + two.persistence!.stats.flushes);
  });

  it('does not republish state it loaded from Postgres', async () => {
    const room = nextRoom();
    const first = await start('one');
    const author = await join(first, room);
    author.insert(0, 'stored earlier');
    await waitUntil(() => first.persistence!.stats.opsWritten > 0, 5000, 'op written');
    author.close();
    await first.stop();
    instances = instances.filter((i) => i !== first);

    const second = await start('two');
    const reader = await join(second, room);
    expect(reader.text).toBe('stored earlier');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(second.bus.docUpdatePublishes()).toBe(0);
  });

  it('still persists a change whose originating instance died before flushing it, via a peer\'s snapshot', async () => {
    const never = 600_000;
    const one = await start('one', { persistFlushIntervalMs: never, snapshotIntervalMs: never });
    const two = await start('two', { snapshotIntervalMs: 150 }); // a peer that snapshots promptly
    const room = nextRoom();
    const a = await join(one, room);
    const b = await join(two, room);

    a.insert(0, 'only the originator logged this');
    await waitUntil(() => b.text === 'only the originator logged this', 5000, 'the peer to receive it');
    expect(one.persistence!.pendingOps(room)).toBeGreaterThan(0); // still unwritten on the originator

    await one.kill(); // the originator dies with the op in its buffer
    instances = instances.filter((i) => i !== one);

    // The op log never got it, which is the hole origin-only writing opens...
    await waitUntil(() => two.persistence!.stats.snapshots >= 1, 8000, 'the peer to snapshot what it holds');
    expect(await store.opCount(room)).toBe(0);

    // ...and the peer's snapshot closes it: a cold start still recovers it.
    b.close();
    await two.stop();
    instances = instances.filter((i) => i !== two);
    await admin.flushall();
    const fresh = await start('three');
    const reader = await join(fresh, room);
    expect(reader.text).toBe('only the originator logged this');
  });

  it('recovers the exact document after every instance stops and Redis is flushed', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const a = await join(one, room);
    const b = await join(two, room);

    for (let i = 0; i < 15; i++) {
      (i % 2 === 0 ? a : b).insert((i % 2 === 0 ? a : b).text.length, `<${i}>`);
      if (i % 5 === 4) a.delete(0, 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await waitUntil(() => a.text === b.text && a.text.length > 0, 5000, 'convergence');
    const expected = a.text;
    const expectedVector = Array.from(Y.encodeStateVector(a.doc));

    a.close();
    b.close();
    await Promise.all(instances.map((i) => i.stop()));
    instances = [];
    await admin.flushall(); // nothing survives in Redis

    const fresh = await start('three');
    const reader = await join(fresh, room);
    expect(reader.text).toBe(expected);
    expect(Array.from(Y.encodeStateVector(reader.doc))).toEqual(expectedVector);
  });

  it('three lossy instances, snapshotting and compacting aggressively, recover the converged state from Postgres alone', async () => {
    const SEED = 20261016;
    const rng = mulberry32(SEED);
    const aggressive = { snapshotEveryOps: 8, snapshotIntervalMs: 120, opRetentionVersions: 2, persistFlushIntervalMs: 25 };
    const trio = [
      await start('one', aggressive, mulberry32(SEED + 1)),
      await start('two', aggressive, mulberry32(SEED + 2)),
      await start('three', aggressive, mulberry32(SEED + 3)),
    ];
    const room = nextRoom();
    const editors = [await join(trio[0]!, room), await join(trio[1]!, room), await join(trio[2]!, room)];
    for (const instance of trio) instance.bus.dropRate = 0.4;

    for (let i = 0; i < 120; i++) {
      const editor = editors[Math.floor(rng() * editors.length)]!;
      const length = editor.text.length;
      if (length > 0 && rng() < 0.35) {
        const start = Math.floor(rng() * length);
        editor.delete(start, 1 + Math.floor(rng() * Math.min(4, length - start)));
      } else {
        editor.insert(Math.floor(rng() * (length + 1)), `w${Math.floor(rng() * 100)} `);
      }
      await new Promise((resolve) => setTimeout(resolve, 6));
    }
    for (const instance of trio) instance.bus.dropRate = 0;
    await waitUntil(() => editors.every((e) => e.text === editors[0]!.text), 10_000, `convergence (seed=${SEED})`);
    const expected = editors[0]!.text;
    expect(expected.length).toBeGreaterThan(0);

    for (const editor of editors) editor.close();
    await Promise.all(trio.map((instance) => instance.stop())); // final snapshots race on the version guard
    instances = [];

    const version = (await store.readSnapshot(room))!.snapshotVersion;
    const compacted = trio.reduce((sum, i) => sum + i.persistence!.stats.opsCompacted, 0);
    const conflicts = trio.reduce((sum, i) => sum + i.persistence!.stats.snapshotConflicts, 0);
    expect(version, `seed=${SEED}: many snapshots happened`).toBeGreaterThan(3);
    expect(compacted, 'compaction actually ran').toBeGreaterThan(0);
    void conflicts;

    await admin.flushall();
    const fresh = await start('four');
    const reader = await join(fresh, room);
    expect(reader.text, `seed=${SEED}, version=${version}`).toBe(expected);
  }, 60_000);
});

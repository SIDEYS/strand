import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { PresenceValue } from '../presence/types.js';
import { MessageType, decode, encodeDocUpdate } from '../protocol/index.js';
import {
  FAST_TIMINGS,
  TcpProxy,
  TestClient,
  mulberry32,
  startInstance,
  waitUntil,
  type Instance,
} from './clusterSupport.js';
import { encodeFrameEnvelope } from './envelope.js';
import { DEMO_MARKDOWN } from '../demo/seed.js';
import { startTestRedis, type TestRedis } from './testRedis.js';

const ada: PresenceValue = { displayName: 'Ada', color: '#f0f', cursor: new Uint8Array([3]), selection: null };
/** With reconciliation effectively off, the only way state can move between
 * instances is the fan-out frames themselves, which is what the tests that
 * inspect fan-out behaviour need to isolate. */
const NO_RECONCILE = { reconcileIntervalMs: 600_000 };

let redis: TestRedis;
let admin: Redis;
let instances: Instance[] = [];
let clients: TestClient[] = [];
let roomCounter = 0;
const nextRoom = () => `room-${++roomCounter}`;

beforeAll(async () => {
  redis = await startTestRedis();
  admin = new Redis(redis.url);
}, 120_000);

afterAll(async () => {
  admin.disconnect();
  await redis.stop();
});

beforeEach(async () => {
  await admin.flushall();
});

afterEach(async () => {
  const toClose = clients;
  const toStop = instances;
  clients = [];
  instances = [];
  for (const client of toClose) client.close();
  for (const instance of toStop) await instance.stop();
});

async function start(id: string, overrides = {}, random?: () => number): Promise<Instance> {
  const instance = await startInstance(redis.url, id, overrides, random);
  instances.push(instance);
  return instance;
}

async function connect(instance: Instance, room: string, doc?: Y.Doc): Promise<TestClient> {
  const client = new TestClient(instance.url, room, doc);
  clients.push(client);
  await client.ready;
  return client;
}

describe('cross-instance replication (real Redis)', () => {
  it('client A on instance 1 and client B on instance 2 converge after concurrent edits', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const a = await connect(one, room);
    const b = await connect(two, room);

    // Concurrent: neither edit has been seen by the other side yet.
    a.insert(0, 'Hello from A. ');
    b.insert(0, 'Hello from B. ');

    await waitUntil(() => a.text === b.text && a.text.length === 28, 5000, 'A and B to converge');
    expect(a.text).toContain('Hello from A. ');
    expect(a.text).toContain('Hello from B. ');
  });

  it('seeds the demo room identically on every instance, so instances never duplicate it', async () => {
    const [one, two] = [await start('one'), await start('two')];
    // Each instance creates the room and seeds it independently, before it
    // has heard from the other.
    const a = await connect(one, 'demo');
    const b = await connect(two, 'demo');
    expect(a.text).toBe(DEMO_MARKDOWN);
    expect(b.text).toBe(DEMO_MARKDOWN);

    // Let reconciliation run between them, then edit on one side.
    await new Promise((resolve) => setTimeout(resolve, 400));
    a.insert(0, '>> ');
    await waitUntil(() => b.text === '>> ' + DEMO_MARKDOWN, 5000, 'edit to replicate');
    expect(a.text).toBe('>> ' + DEMO_MARKDOWN);
  });

  it('does not re-publish an update that arrived from a peer (one edit, one publish, across three instances)', async () => {
    const [one, two, three] = [
      await start('one', NO_RECONCILE),
      await start('two', NO_RECONCILE),
      await start('three', NO_RECONCILE),
    ];
    const room = nextRoom();
    const a = await connect(one, room);
    const b = await connect(two, room);
    const c = await connect(three, room);

    a.insert(0, 'one edit');
    await waitUntil(() => b.text === 'one edit' && c.text === 'one edit', 5000, 'peers to receive the edit');
    // Bounded observation window for a negative: an echo loop would show up
    // as further publishes almost immediately.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const total = [one, two, three].reduce((sum, i) => sum + i.bus.docUpdatePublishes(), 0);
    expect(total).toBe(1);
    expect(one.bus.docUpdatePublishes()).toBe(1);
  });

  it('drops a message carrying its own instance ID instead of applying it', async () => {
    const [one, two] = [await start('one', NO_RECONCILE), await start('two', NO_RECONCILE)];
    const room = nextRoom();
    const a = await connect(one, room);
    const b = await connect(two, room);

    const forged = new Y.Doc();
    let update: Uint8Array = new Uint8Array();
    forged.on('update', (u: Uint8Array) => (update = u));
    forged.getText('content').insert(0, 'FORGED');
    const frame = encodeDocUpdate(update);
    expect(decode(frame).type).toBe(MessageType.DocUpdate);

    // Claims to originate from instance "two". Instance one must apply it;
    // instance two, being the claimed origin, must treat it as its own echo.
    await admin.publish(`strand:room:${room}`, Buffer.from(encodeFrameEnvelope('two', '', frame)));

    await waitUntil(() => a.text === 'FORGED', 5000, 'instance one to apply the message');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(b.text).toBe('');
  });

  it('a client reconnecting to a different instance mid-session sees correct state and keeps its offline edits', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const keeper = await connect(one, room); // keeps the room alive on instance one
    const traveller = await connect(one, room);

    traveller.insert(0, 'online ');
    await waitUntil(() => keeper.text === 'online ', 5000, 'keeper to see the traveller');

    const travellerDoc = traveller.doc;
    traveller.close(); // disconnects; its doc survives, as a browser tab's would
    keeper.insert(keeper.text.length, 'while-away ');
    travellerDoc.getText('content').insert(0, 'offline ');

    // Instance two has never hosted this room, so it has to rebuild it from
    // instance one before it can serve this client.
    const returned = await connect(two, room, travellerDoc);

    await waitUntil(
      () => returned.text === keeper.text && keeper.text.includes('offline ') && keeper.text.includes('while-away '),
      5000,
      'both sides to hold the merged document',
    );
    expect(keeper.text).toContain('online ');
  });

  it('a fresh client joining a cold instance is not shown an empty document', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const author = await connect(one, room);
    author.insert(0, 'already here');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const joiner = await connect(two, room);
    // `ready` resolves once the first SyncStep2 is applied, which the
    // gateway only sends after instance two has caught up with its peers.
    expect(joiner.text).toBe('already here');
  });

  it('removes presence for a client on a killed instance within the TTL window', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const doomed = await connect(one, room);
    const watcher = await connect(two, room);

    doomed.setPresence(ada);
    await waitUntil(() => watcher.presence.size === 1, 5000, 'watcher to see presence');

    // Alive and refreshing: entry must outlive several TTLs.
    const aliveUntil = Date.now() + FAST_TIMINGS.presenceTtlMs! * 2;
    while (Date.now() < aliveUntil) {
      expect(watcher.presence.size).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await one.kill();
    instances = instances.filter((i) => i !== one);

    // Redis expires the entry at most one TTL after the last refresh; the
    // survivor notices on its next sync tick (interval, with up to +20% jitter).
    const bound = FAST_TIMINGS.presenceTtlMs! + FAST_TIMINGS.reconcileIntervalMs! * 1.2 + 2000;
    const elapsed = await waitUntil(() => watcher.presence.size === 0, bound, 'ghost presence to expire');
    expect(elapsed).toBeLessThan(bound);
  }, 20_000);

  it('heals a burst of dropped messages, including a deletion', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const a = await connect(one, room);
    const b = await connect(two, room);

    a.insert(0, 'hello world');
    await waitUntil(() => b.text === 'hello world', 5000, 'initial replication');

    two.bus.dropRate = 1; // instance two stops hearing anything
    a.insert(11, ' and more');
    a.delete(0, 6);
    await waitUntil(() => a.text === 'world and more', 5000, 'local edits');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(two.bus.dropped).toBeGreaterThan(0);
    expect(b.text).toBe('hello world'); // the loss really happened

    two.bus.dropRate = 0;
    await waitUntil(() => b.text === a.text, 5000, 'reconciliation to repair instance two');
    expect(b.text).toBe('world and more');
  });

  it('heals a lost deletion-only update, which a state vector alone cannot detect', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const a = await connect(one, room);
    const b = await connect(two, room);

    a.insert(0, 'delete me please');
    await waitUntil(() => b.text === a.text, 5000, 'initial replication');

    two.bus.dropRate = 1;
    a.delete(0, 10); // adds no structs: instance two's state vector is unchanged
    await waitUntil(() => a.text === 'please', 5000, 'local deletion');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(b.text).toBe('delete me please');

    two.bus.dropRate = 0;
    await waitUntil(() => b.text === 'please', 5000, 'deletion to be repaired by the delete-set digest');
  });

  it('keeps serving edits through a real partition from Redis, then converges and restores presence once it heals', async () => {
    const proxy = await TcpProxy.start(new URL(redis.url).hostname, Number(new URL(redis.url).port));
    try {
      const one = await start('one');
      const two = await startInstance(proxy.url, 'two'); // reaches Redis only through the proxy
      instances.push(two);
      const room = nextRoom();
      const a = await connect(one, room);
      const b = await connect(two, room);

      b.setPresence(ada);
      await waitUntil(() => a.presence.size === 1, 5000, 'presence to replicate');

      proxy.sever();
      a.insert(0, 'left ');
      b.insert(0, 'right ');
      // Each side keeps working locally; neither can see the other.
      await waitUntil(() => a.text === 'left ' && b.text === 'right ', 3000, 'local edits during the partition');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(a.text).toBe('left ');
      expect(b.text).toBe('right ');

      // b's presence can no longer be refreshed, so it lapses for everyone
      // who can still reach Redis.
      const bound = FAST_TIMINGS.presenceTtlMs! + FAST_TIMINGS.reconcileIntervalMs! * 1.2 + 2000;
      await waitUntil(() => a.presence.size === 0, bound, 'presence of the partitioned client to lapse');

      proxy.heal();
      await waitUntil(
        () => a.text === b.text && a.text.includes('left ') && a.text.includes('right '),
        15_000,
        'documents to converge after the partition heals',
      );
      // Self-healing in the direction that matters: b's next heartbeat
      // re-stamps its presence, which beats the removal a synthesised.
      await waitUntil(() => a.presence.size === 1, 15_000, 'presence to reappear after the partition heals');
    } finally {
      await proxy.close();
    }
  }, 60_000);

  it('converges three instances after heavy random loss and random edits', async () => {
    const SEED = 20261008;
    const rng = mulberry32(SEED);
    const trio = [
      await start('one', {}, mulberry32(SEED + 1)),
      await start('two', {}, mulberry32(SEED + 2)),
      await start('three', {}, mulberry32(SEED + 3)),
    ];
    const room = nextRoom();
    const editors = [await connect(trio[0]!, room), await connect(trio[1]!, room), await connect(trio[2]!, room)];

    for (const instance of trio) instance.bus.dropRate = 0.4;

    for (let i = 0; i < 150; i++) {
      const editor = editors[Math.floor(rng() * editors.length)]!;
      const length = editor.text.length;
      if (length > 0 && rng() < 0.35) {
        const start = Math.floor(rng() * length);
        editor.delete(start, 1 + Math.floor(rng() * Math.min(5, length - start)));
      } else {
        editor.insert(Math.floor(rng() * (length + 1)), `w${Math.floor(rng() * 100)} `);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const dropped = trio.reduce((sum, i) => sum + i.bus.dropped, 0);
    expect(dropped, `seed=${SEED}: the lossy phase must actually drop messages`).toBeGreaterThan(0);
    expect(editors[0]!.text.length).toBeGreaterThan(0);

    for (const instance of trio) instance.bus.dropRate = 0;
    await waitUntil(
      () => editors.every((e) => e.text === editors[0]!.text),
      10_000,
      `all replicas to converge (seed=${SEED}, dropped=${dropped})`,
    );
  }, 30_000);
});

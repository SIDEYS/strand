import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { PresenceValue } from '../presence/types.js';
import { CloseCode, PROTOCOL_VERSION } from '../protocol/index.js';
import {
  ResilientClient,
  TestClient,
  mulberry32,
  startInstance,
  waitUntil,
  type Instance,
} from './clusterSupport.js';
import { startTestRedis, type TestRedis } from './testRedis.js';

const ada: PresenceValue = { displayName: 'Ada', color: '#f0f', cursor: 3, selection: null };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let redis: TestRedis;
let admin: Redis;
let instances: Instance[] = [];
let tabs: Array<{ close(): void }> = [];
let roomCounter = 0;
const nextRoom = () => `resume-room-${++roomCounter}`;

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
  const toClose = tabs;
  const toStop = instances;
  tabs = [];
  instances = [];
  for (const tab of toClose) tab.close();
  for (const instance of toStop) await instance.stop();
});

async function start(id: string, overrides = {}, random?: () => number): Promise<Instance> {
  const instance = await startInstance(redis.url, id, overrides, random);
  instances.push(instance);
  return instance;
}

async function connect(instance: Instance, room: string, resumeToken?: Uint8Array): Promise<TestClient> {
  const client = new TestClient(instance.url, room, undefined, resumeToken);
  tabs.push(client);
  await client.ready;
  return client;
}

describe('resume across instances (real Redis)', () => {
  it('resuming on another instance fences the stale connection and keeps the identity and presence', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const watcher = await connect(two, room);
    const stale = await connect(one, room); // alive on the wire but, say, behind a dead NAT mapping
    stale.setPresence(ada);
    await waitUntil(() => watcher.presence.size === 1, 5000, 'presence to replicate');
    const token = stale.token!;
    expect(token).not.toBeNull();

    const revived = await connect(two, room, token);

    expect(revived.clientId).toBe(stale.clientId);
    expect(revived.resumed).toBe(true);
    await waitUntil(() => stale.closeCode !== null, 5000, 'the stale connection to be fenced');
    expect(stale.closeCode).toBe(CloseCode.Superseded);

    // The person never left, so nobody should have seen them go.
    await sleep(300);
    expect([...watcher.presence.keys()]).toEqual([stale.clientId]);

    // And the shared lease now belongs to the new connection, on instance two.
    const owner = await admin.hget(`strand:{${room}}:sessions:owners`, stale.clientId);
    expect(owner?.startsWith('two/')).toBe(true);
  });

  it('fences the stale connection even when the fence message is lost, via the heartbeat lease check', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const stale = await connect(one, room);
    const token = stale.token!;

    one.bus.dropRate = 1; // instance one hears nothing from Redis pub/sub
    await connect(two, room, token);

    // The fence message is discarded on arrival, so it cannot be what stops
    // the stale connection. It keeps answering pings, so the only thing
    // left is finding, on its own heartbeat, that another connection owns
    // the lease. (Not asserted by timing, which would be a race: this test
    // was checked by removing that heartbeat check and watching it fail.)
    await waitUntil(() => stale.closeCode !== null, 5000, 'the stale connection to fence itself');
    expect(stale.closeCode).toBe(CloseCode.Superseded);
    expect(one.bus.dropped).toBeGreaterThan(0);
  });

  it('leaves exactly one live connection when the same token is replayed on two instances at once', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const original = await connect(one, room);
    const token = original.token!;
    original.close();
    await waitUntil(() => original.closeCode !== null, 3000, 'original to close');

    // Two tabs restored after a crash, or a replayed token, racing.
    const a = new TestClient(one.url, room, undefined, token);
    const b = new TestClient(two.url, room, undefined, token);
    tabs.push(a, b);

    const live = () => [a, b].filter((c) => c.closeCode === null && c.clientId !== '').length;
    await waitUntil(() => [a, b].some((c) => c.closeCode === CloseCode.Superseded) && live() === 1, 8000, 'one to be fenced');
    await sleep(400); // stays settled: no flapping, no second fencing
    expect(live()).toBe(1);
    expect(a.clientId).toBe(b.clientId);
    expect(a.clientId).toBe(original.clientId);
  });

  it('does not auto-retry a superseded session, so two tabs cannot evict each other forever', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const first = new ResilientClient({ roomId: room, pickUrl: () => one.url, random: mulberry32(1) });
    tabs.push(first);
    first.start();
    await first.connected();

    const second = await connect(two, room, first.token!);
    expect(second.resumed).toBe(true);

    await waitUntil(() => first.state.status === 'failed', 5000, 'first tab to give up');
    expect(first.state).toEqual({ status: 'failed', reason: 'superseded' });
    await sleep(400); // a fighting client would have reconnected by now
    expect(first.connectAttempts).toBe(1);

    // The user can still take the session back deliberately.
    first.manualReconnect();
    await first.connected();
    expect(first.resumedFlags).toEqual([false, true]);
    await waitUntil(() => second.closeCode === CloseCode.Superseded, 5000, 'second tab to be fenced in turn');
  });

  it('survives a killed socket mid-edit: reconnects elsewhere with the same identity, no lost edits, no duplicate presence', async () => {
    const [one, two, three] = [await start('one'), await start('two'), await start('three')];
    const room = nextRoom();
    const watcher = await connect(three, room);

    // First attempt lands on instance one; every later one on instance two,
    // as a load balancer with no stickiness might send it.
    const client = new ResilientClient({
      roomId: room,
      pickUrl: (attempt) => (attempt === 1 ? one.url : two.url),
      random: mulberry32(42),
    });
    tabs.push(client);
    client.start();
    await client.connected();
    client.setPresence(ada);
    await waitUntil(() => watcher.presence.size === 1, 5000, 'presence to appear');
    const originalId = client.clientId;

    let maxPresenceEntries = 0;
    const sampler = setInterval(() => {
      maxPresenceEntries = Math.max(maxPresenceEntries, watcher.presence.size);
    }, 5);

    const EDITS = 25;
    for (let i = 0; i < EDITS; i++) {
      client.insert(client.text.length, `[${i}]`);
      if (i === 9) client.killSocket(); // mid-edit; the rest are typed while disconnected
      await sleep(8);
    }
    await client.connected();

    const markers = Array.from({ length: EDITS }, (_, i) => `[${i}]`);
    await waitUntil(() => markers.every((m) => watcher.text.includes(m)), 8000, 'every edit to reach the other side');
    await waitUntil(() => watcher.presence.size === 1, 8000, 'presence to be restored');
    await sleep(200);
    clearInterval(sampler);

    expect(client.clientId).toBe(originalId);
    expect(client.resumedFlags).toEqual([false, true]);
    expect(client.closeCodes[0]).toBe(1006);
    expect(client.connectAttempts).toBeGreaterThanOrEqual(2);
    expect(watcher.text).toBe(client.text); // identical, not merely containing every edit
    expect([...watcher.presence.keys()]).toEqual([originalId]);
    expect(maxPresenceEntries, 'never two entries for one person').toBeLessThanOrEqual(1);
  }, 30_000);

  it('does not reconnect-loop against a protocol version mismatch', async () => {
    const one = await start('one');
    const client = new ResilientClient({
      roomId: nextRoom(),
      pickUrl: () => one.url,
      protocolVersion: PROTOCOL_VERSION - 1,
      random: mulberry32(3),
    });
    tabs.push(client);
    client.start();

    await waitUntil(() => client.state.status === 'failed', 5000, 'client to give up');
    expect(client.state).toEqual({ status: 'failed', reason: 'version-mismatch' });
    await sleep(400); // a looping client would have retried several times by now
    expect(client.connectAttempts).toBe(1);
    expect(client.closeCodes).toEqual([CloseCode.ProtocolVersionMismatch]);
  });

  it('reconnect cost follows what was missed, not the size of the document', async () => {
    const [one, two] = [await start('one'), await start('two')];
    const room = nextRoom();
    const keeper = await connect(one, room); // holds the room alive on instance one

    const client = new ResilientClient({
      roomId: room,
      pickUrl: (attempt) => (attempt === 1 ? one.url : two.url),
      random: mulberry32(7),
    });
    tabs.push(client);
    client.start();
    await client.connected();

    const BIG = 100_000;
    client.insert(0, 'x'.repeat(BIG));
    await waitUntil(() => keeper.text.length === BIG, 8000, 'the large document to replicate');
    const fullStateBytes = Y.encodeStateAsUpdate(client.doc).length;
    expect(fullStateBytes).toBeGreaterThan(BIG);

    client.killSocket();
    // One character typed as the connection drops. The socket is already
    // dead, so this never reaches the server over the old connection and
    // has to be recovered by the resync on the new one.
    client.insert(5, 'y');
    await waitUntil(() => client.connectAttempts >= 2 && client.state.status === 'connected', 5000, 'to reconnect');
    await waitUntil(() => keeper.text.includes('y'), 8000, 'the offline edit to arrive');
    await sleep(200); // let the resync exchange finish

    // Everything this connection exchanged, handshake to settled: orders of
    // magnitude under a document that is >100 KB.
    expect(client.bytesSent).toBeLessThan(1500);
    expect(client.bytesReceived).toBeLessThan(1500);
    expect(client.text).toBe(keeper.text);
  }, 30_000);
});

import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectRedis } from './bus.js';
import { SessionStore, instanceOfOwner, makeOwnerId } from './sessionStore.js';
import { startTestRedis, type TestRedis } from './testRedis.js';

const TTL_MS = 500;

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('SessionStore (real Redis)', () => {
  let redis: TestRedis;
  let client: Redis;
  let store: SessionStore;

  beforeAll(async () => {
    redis = await startTestRedis();
    client = await connectRedis(redis.url, { failFast: true, logger: pino({ level: 'silent' }) });
    store = new SessionStore(client, TTL_MS);
  }, 120_000);

  afterAll(async () => {
    client.disconnect();
    await redis.stop();
  });

  beforeEach(async () => {
    await client.flushall();
  });

  it('round-trips owner IDs, including an instance ID that itself contains a slash', () => {
    expect(instanceOfOwner(makeOwnerId('inst-1', 'conn-9'))).toBe('inst-1');
    expect(instanceOfOwner(makeOwnerId('region/a/inst-1', 'conn-9'))).toBe('region/a/inst-1');
  });

  it('a first claim displaces nobody', async () => {
    expect(await store.claim('room', 'client', 'i1/c1')).toBeNull();
  });

  it('a second claim wins and reports the live owner it displaced', async () => {
    await store.claim('room', 'client', 'i1/c1');
    expect(await store.claim('room', 'client', 'i2/c2')).toBe('i1/c1');
  });

  it('does not report an owner whose lease has expired', async () => {
    await store.claim('room', 'client', 'i1/c1');
    await waitUntil(async () => (await client.exists('strand:{room}:sessions:owners')) === 0, TTL_MS * 3 + 2000);
    expect(await store.claim('room', 'client', 'i2/c2')).toBeNull();
  });

  it('keeps leases per client and per room independent', async () => {
    await store.claim('room', 'a', 'i1/c1');
    expect(await store.claim('room', 'b', 'i2/c2')).toBeNull();
    expect(await store.claim('other-room', 'a', 'i3/c3')).toBeNull();
  });

  it('touch succeeds for the owner and fails for a displaced one', async () => {
    await store.claim('room', 'client', 'i1/c1');
    await store.claim('room', 'client', 'i2/c2'); // newest wins
    expect(await store.touch('room', 'client', 'i2/c2')).toBe(true);
    expect(await store.touch('room', 'client', 'i1/c1')).toBe(false);
  });

  it('touch re-takes a lease that has vanished instead of fencing a live client', async () => {
    await store.claim('room', 'client', 'i1/c1');
    await client.flushall(); // Redis lost its state; the client is still connected
    expect(await store.touch('room', 'client', 'i1/c1')).toBe(true);
    // ...and it really is the owner again.
    expect(await store.claim('room', 'client', 'i2/c2')).toBe('i1/c1');
  });

  it('a displaced connection cannot release its successor\'s lease on its way out', async () => {
    await store.claim('room', 'client', 'i1/c1');
    await store.claim('room', 'client', 'i2/c2');
    await store.release('room', 'client', 'i1/c1'); // stale owner leaving
    expect(await store.claim('room', 'client', 'i3/c3')).toBe('i2/c2'); // successor's lease survived
  });

  it('release by the owner frees the ID', async () => {
    await store.claim('room', 'client', 'i1/c1');
    await store.release('room', 'client', 'i1/c1');
    expect(await store.claim('room', 'client', 'i2/c2')).toBeNull();
  });

  it('exactly one of many concurrent claims is displaced by each later one (no two owners)', async () => {
    const owners = Array.from({ length: 20 }, (_, i) => `i${i}/c${i}`);
    const displaced = await Promise.all(owners.map((owner) => store.claim('room', 'client', owner)));
    // 20 claims serialised by Redis: the first displaces nobody, and every
    // later one displaces exactly one earlier owner, each owner at most once.
    expect(displaced.filter((d) => d === null)).toHaveLength(1);
    const seen = displaced.filter((d): d is string => d !== null);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PresenceValue } from '../presence/types.js';
import { connectRedis } from './bus.js';
import { PresenceStore } from './presenceStore.js';
import { startTestRedis, type TestRedis } from './testRedis.js';

const value: PresenceValue = { displayName: 'Ada', color: '#f0f', cursor: new Uint8Array([4]), selection: null };
const TTL_MS = 600;

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Date.now() - start;
}

describe('PresenceStore (real Redis)', () => {
  let redis: TestRedis;
  let client: Redis;
  let store: PresenceStore;

  beforeAll(async () => {
    redis = await startTestRedis();
    client = await connectRedis(redis.url, { failFast: true, logger: pino({ level: 'silent' }) });
    store = new PresenceStore(client, TTL_MS);
  }, 120_000);

  afterAll(async () => {
    client.disconnect();
    await redis.stop();
  });

  beforeEach(async () => {
    await client.flushall();
  });

  it('lists what was upserted, keyed per room', async () => {
    await store.upsert('room-1', { clientId: 'a', timestamp: 10, value });
    await store.upsert('room-2', { clientId: 'b', timestamp: 11, value });
    expect(await store.list('room-1')).toEqual([{ clientId: 'a', timestamp: 10, value }]);
    expect(await store.list('room-2')).toEqual([{ clientId: 'b', timestamp: 11, value }]);
  });

  it('removes an entry explicitly', async () => {
    await store.upsert('room-1', { clientId: 'a', timestamp: 10, value });
    await store.remove('room-1', 'a');
    expect(await store.list('room-1')).toEqual([]);
  });

  it('keeps only the latest write for a client', async () => {
    await store.upsert('room-1', { clientId: 'a', timestamp: 10, value });
    await store.upsert('room-1', { clientId: 'a', timestamp: 20, value: { ...value, cursor: new Uint8Array([9]) } });
    const entries = await store.list('room-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ timestamp: 20, value: { cursor: new Uint8Array([9]) } });
  });

  it('expires an entry that is never refreshed', async () => {
    await store.upsert('room-1', { clientId: 'ghost', timestamp: 10, value });
    expect(await store.list('room-1')).toHaveLength(1);
    // Upper bound only: it must be gone by some point after the TTL.
    const elapsed = await waitUntil(async () => (await store.list('room-1')).length === 0, TTL_MS + 3000);
    expect(elapsed).toBeLessThan(TTL_MS + 3000);
  });

  it('keeps an entry alive while it is being refreshed past the original TTL', async () => {
    const start = Date.now();
    while (Date.now() - start < TTL_MS * 2) {
      await store.upsert('room-1', { clientId: 'live', timestamp: Date.now(), value });
      await new Promise((resolve) => setTimeout(resolve, TTL_MS / 6));
    }
    expect(await store.list('room-1')).toHaveLength(1);

    await waitUntil(async () => (await store.list('room-1')).length === 0, TTL_MS + 3000);
  });

  it('leaves no keys behind once a room has fully expired', async () => {
    await store.upsert('room-1', { clientId: 'a', timestamp: 10, value });
    await waitUntil(async () => (await client.keys('strand:*')).length === 0, TTL_MS * 2 + 3000);
  });
});

import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TcpProxy, TestClient, startInstance, waitUntil, type Instance } from '../transport/clusterSupport.js';
import { connectRedis } from '../transport/bus.js';
import { startTestRedis, type TestRedis } from '../transport/testRedis.js';
import { createReadiness } from './readiness.js';
import { buildApiServer } from './server.js';

const logger = pino({ level: 'silent' });

let redis: TestRedis;
let proxy: TcpProxy;
let probe: Redis;
let instance: Instance | undefined;
let clients: TestClient[] = [];

beforeAll(async () => {
  redis = await startTestRedis();
  proxy = await TcpProxy.start(new URL(redis.url).hostname, Number(new URL(redis.url).port));
  probe = await connectRedis(proxy.url, { failFast: true, logger });
}, 120_000);

afterAll(async () => {
  probe.disconnect();
  await proxy.close();
  await redis.stop();
});

afterEach(async () => {
  proxy.heal();
  for (const client of clients) client.close();
  clients = [];
  await instance?.stop();
  instance = undefined;
});

describe('readiness during a real Redis outage', () => {
  it('goes 503 while the process stays alive and keeps serving its existing sockets, then recovers', async () => {
    instance = await startInstance(proxy.url, 'one');
    const app = buildApiServer(logger, {
      readiness: createReadiness({ redis: () => probe.ping(), cacheMs: 0, timeoutMs: 500 }),
    });
    const a = new TestClient(instance.url, 'room-ready');
    const b = new TestClient(instance.url, 'room-ready');
    clients.push(a, b);
    await Promise.all([a.ready, b.ready]);
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(200);

    proxy.sever(); // Redis becomes unreachable for this instance
    let status = 200;
    const deadline = Date.now() + 5000;
    while (status !== 503 && Date.now() < deadline) {
      status = (await app.inject({ url: '/readyz' })).statusCode;
      if (status !== 503) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status).toBe(503);
    expect((await app.inject({ url: '/readyz' })).json()).toMatchObject({ status: 'not_ready', redis: 'down' });

    // Not ready is not unhealthy: liveness is unaffected...
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    // ...and the instance is still doing its job for the sockets it has.
    expect(a.core.getSnapshot().status).toBe('connected');
    a.insert(0, 'typed during the redis outage');
    await waitUntil(() => b.text === 'typed during the redis outage', 3000, 'a local edit to reach the other local client');

    proxy.heal();
    const recovery = Date.now() + 15_000;
    while ((await app.inject({ url: '/readyz' })).statusCode !== 200) {
      if (Date.now() > recovery) throw new Error('readyz never recovered');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await app.close();
  }, 40_000);
});

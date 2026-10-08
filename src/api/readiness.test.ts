import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createReadiness } from './readiness.js';
import { buildApiServer } from './server.js';

const ok = () => Promise.resolve('PONG');
const fails = () => Promise.reject(new Error('ECONNREFUSED'));
const hangs = () => new Promise<never>(() => undefined);

describe('createReadiness', () => {
  it('is ready when every configured dependency answers', async () => {
    const report = await createReadiness({ redis: ok, postgres: ok })();
    expect(report).toEqual({ ready: true, checks: { redis: 'ok', postgres: 'ok' } });
  });

  it('treats a dependency that is not configured as fine, and says so', async () => {
    const report = await createReadiness({})();
    expect(report).toEqual({ ready: true, checks: { redis: 'disabled', postgres: 'disabled' } });
  });

  it('is not ready when one dependency fails, and names which', async () => {
    const report = await createReadiness({ redis: fails, postgres: ok })();
    expect(report).toEqual({ ready: false, checks: { redis: 'down', postgres: 'ok' } });
  });

  it('counts a probe that never answers as down instead of waiting for it', async () => {
    const started = Date.now();
    const report = await createReadiness({ redis: hangs, postgres: ok, timeoutMs: 50 })();
    expect(report.checks.redis).toBe('down');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('turns a probe that throws synchronously into down, never an exception', async () => {
    const throws = (): Promise<unknown> => {
      throw new Error('boom');
    };
    await expect(createReadiness({ postgres: throws })()).resolves.toMatchObject({ ready: false });
  });

  it('reuses a result inside the cache window and re-probes after it', async () => {
    let calls = 0;
    let now = 0;
    const readiness = createReadiness({
      redis: () => {
        calls += 1;
        return Promise.resolve();
      },
      cacheMs: 1000,
      now: () => now,
    });
    await readiness();
    now = 999;
    await readiness();
    expect(calls).toBe(1);
    now = 1000;
    await readiness();
    expect(calls).toBe(2);
  });

  it('lets a burst of concurrent checks share one probe run, so load balancers cannot become load', async () => {
    let calls = 0;
    const readiness = createReadiness({
      redis: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      cacheMs: 0,
    });
    await Promise.all(Array.from({ length: 50 }, () => readiness()));
    expect(calls).toBe(1);
  });

  it('notices recovery once the cache window has passed', async () => {
    let healthy = false;
    let now = 0;
    const readiness = createReadiness({ redis: () => (healthy ? Promise.resolve() : fails()), cacheMs: 100, now: () => now });
    expect((await readiness()).ready).toBe(false);
    healthy = true;
    now = 150;
    expect((await readiness()).ready).toBe(true);
  });
});

describe('/healthz versus /readyz', () => {
  const logger = pino({ level: 'silent' });

  it('reports 503 from /readyz while /healthz stays 200: unready is not unhealthy', async () => {
    const app = buildApiServer(logger, { readiness: createReadiness({ redis: fails }) });
    const ready = await app.inject({ url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready', redis: 'down', postgres: 'disabled' });
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });

  it('reports 200 from /readyz when dependencies are up, or when there are none', async () => {
    const up = buildApiServer(logger, { readiness: createReadiness({ redis: ok, postgres: ok }) });
    expect((await up.inject({ url: '/readyz' })).json()).toEqual({ status: 'ready', redis: 'ok', postgres: 'ok' });
    await up.close();

    const none = buildApiServer(logger);
    expect((await none.inject({ url: '/readyz' })).statusCode).toBe(200);
    await none.close();
  });

  it('stamps every response with the instance that served it', async () => {
    const app = buildApiServer(logger, { instanceId: 'strand-2' });
    expect((await app.inject({ url: '/healthz' })).headers['x-strand-instance']).toBe('strand-2');
    await app.close();
  });
});

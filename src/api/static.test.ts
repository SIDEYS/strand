import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApiServer } from './server.js';
import { resolveStaticFile } from './static.js';

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'strand-static-'));
  root = path.join(base, 'dist');
  outside = path.join(base, 'secret.txt');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>app</title>');
  await writeFile(path.join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
  await writeFile(path.join(root, 'favicon.svg'), '<svg/>');
  await writeFile(outside, 'TOP SECRET');
  await symlink(outside, path.join(root, 'link-out.txt'));
});

afterAll(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

describe('resolveStaticFile', () => {
  it('serves a real file with its content type', async () => {
    const found = await resolveStaticFile(root, '/favicon.svg');
    expect(found).toMatchObject({ contentType: 'image/svg+xml', immutable: false });
  });

  it('marks hashed build assets immutable, and the HTML shell not', async () => {
    expect((await resolveStaticFile(root, '/assets/app-abc123.js'))?.immutable).toBe(true);
    expect((await resolveStaticFile(root, '/'))?.immutable).toBe(false);
  });

  it('gives client-side routes the app shell so deep links and reloads work', async () => {
    for (const route of ['/', '/r/demo', '/r/some-room/', '/anything/else']) {
      expect((await resolveStaticFile(root, route))?.file, route).toBe(path.join(root, 'index.html'));
    }
  });

  it('404s a missing asset instead of returning HTML where a script was expected', async () => {
    expect(await resolveStaticFile(root, '/assets/missing.js')).toBeNull();
    expect(await resolveStaticFile(root, '/nope.png')).toBeNull();
  });

  it('refuses to leave the root, however the path is spelled', async () => {
    const attempts = [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E%2Fsecret.txt',
      '/assets/../../secret.txt',
      '//../secret.txt',
      '/....//secret.txt',
      '/..\\secret.txt',
      '/%00/../secret.txt',
    ];
    for (const attempt of attempts) {
      const found = await resolveStaticFile(root, attempt);
      expect(found?.file ?? null, attempt).not.toBe(outside);
      if (found) expect(found.file.startsWith(root), attempt).toBe(true);
    }
  });

  it('does not follow a symlink inside the root that points outside it', async () => {
    expect(await resolveStaticFile(root, '/link-out.txt')).toBeNull();
    const app = buildApiServer(pino({ level: 'silent' }), { staticRoot: root });
    const response = await app.inject({ url: '/link-out.txt' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('TOP SECRET');
    await app.close();
  });

  it('rejects malformed percent-encoding rather than throwing', async () => {
    expect(await resolveStaticFile(root, '/%E0%A4%A')).toBeNull();
  });
});

describe('API with static serving', () => {
  it('serves the app, the assets, and still answers /healthz', async () => {
    const app = buildApiServer(pino({ level: 'silent' }), { staticRoot: root });
    const page = await app.inject({ url: '/r/demo' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-cache');

    const asset = await app.inject({ url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');

    expect((await app.inject({ url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ url: '/assets/missing.js' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/..%2fsecret.txt' })).body).not.toContain('TOP SECRET');
    await app.close();
  });

  it('serves only the API when no static root is given', async () => {
    const app = buildApiServer(pino({ level: 'silent' }));
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });
});

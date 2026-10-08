// Smoke test for a running multi-instance setup (docker compose up).
//
//   node loadtest/smoke.mjs [base-url]      (default http://localhost:8080)
//
// Needs `npm run build` first: it drives the real client core from dist/.
// Exits non-zero if anything is wrong, so CI can use it as a gate.
import { WebSocket } from 'ws';
import { CollabClient } from '../dist/client/core.js';

const base = process.argv[2] ?? 'http://localhost:8080';
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

const scheduler = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

async function until(fn, ms) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) return false;
    await sleep(20);
  }
  return true;
}

/** A client plus the instance the load balancer sent it to (read from the
 * WebSocket upgrade response). */
function connect(room) {
  const info = { instance: null };
  const client = new CollabClient({
    roomId: room,
    url: () => wsUrl,
    socketFactory: (url) => {
      const ws = new WebSocket(url);
      ws.on('upgrade', (res) => (info.instance = res.headers['x-strand-instance'] ?? null));
      return ws;
    },
    scheduler,
    random: Math.random,
  });
  client.start();
  return { client, info };
}

const text = (c) => c.doc.getText('content').toJSON();

// 1. The page and the endpoints.
const html = await fetch(base + '/r/demo').then((r) => r.text());
check(html.includes('<title>Strand'), 'the web client is served');
check((await fetch(base + '/healthz')).status === 200, '/healthz is 200');
check((await fetch(base + '/readyz')).status === 200, '/readyz is 200 (Redis and Postgres reachable)');
check((await fetch(base + '/metrics')).status === 404, '/metrics is not exposed through the load balancer');

// 2. Two clients on DIFFERENT instances, in the same room, see each other.
const room = `smoke-${Date.now().toString(36)}`;
let a = connect(room);
let b = connect(room);
await until(() => a.info.instance && b.info.instance, 5000);
for (let tries = 0; a.info.instance === b.info.instance && tries < 8; tries++) {
  b.client.stop();
  b = connect(room);
  await until(() => b.info.instance, 3000);
}
check(a.info.instance !== null && b.info.instance !== null && a.info.instance !== b.info.instance,
  `the two clients landed on different instances (${a.info.instance} and ${b.info.instance})`);

await until(() => a.client.getSnapshot().synced && b.client.getSnapshot().synced, 5000);
a.client.doc.getText('content').insert(0, 'from-a ');
check(await until(() => text(b.client).includes('from-a'), 3000), `an edit on ${a.info.instance} reaches ${b.info.instance}`);
b.client.doc.getText('content').insert(0, 'from-b ');
check(await until(() => text(a.client).includes('from-b'), 3000), `an edit on ${b.info.instance} reaches ${a.info.instance}`);
check(await until(() => text(a.client) === text(b.client), 3000), 'both replicas converge to identical text');

// 3. The demo room is seeded, whichever instance serves it.
const demo = connect('demo');
check(await until(() => demo.client.getSnapshot().synced && text(demo.client).includes('Welcome to Strand'), 5000),
  'the demo room is seeded with its walkthrough');

a.client.stop();
b.client.stop();
demo.client.stop();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

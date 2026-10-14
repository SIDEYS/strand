// Post-run integrity check: after a load run, did every edit the generator
// produced end up in its room, exactly once, and do all instances agree?
//
//   node loadtest/verify.mjs --run <RUN_ID> --vus <N> --room-size <K> [--expect <edits_sent>] [--base http://localhost:8080]
//
// It reads each room back through the real client core (so a wrong answer
// cannot come from a bug in the generator's own encoder) and checks:
//   - every VU's markers are contiguous from 1 to its highest seq (no lost edit,
//     including edits that were in flight when a connection or instance died);
//   - none appears twice;
//   - with --expect, the total across all rooms equals the number of edits the
//     generator reports having produced.
// Run it twice against different instances (--base) to also show they agree.
import { WebSocket } from 'ws';
import { CollabClient } from '../dist/client/core.js';
import { extractMarkers } from './lib/frames.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const run = arg('run');
const vus = Number(arg('vus'));
const roomSize = Number(arg('room-size', 5));
const expected = arg('expect') === undefined ? null : Number(arg('expect'));
const base = arg('base', 'http://localhost:8080');
if (!run || !vus) {
  console.error('usage: verify.mjs --run <id> --vus <n> [--room-size 5] [--expect <edits>] [--base url]');
  process.exit(2);
}

const scheduler = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readRoom(roomId) {
  const client = new CollabClient({
    roomId,
    url: () => base.replace(/^http/, 'ws') + '/ws',
    socketFactory: (url) => new WebSocket(url),
    scheduler,
    random: Math.random,
  });
  client.start();
  const started = Date.now();
  while (!client.getSnapshot().synced) {
    if (Date.now() - started > 20000) throw new Error(`room ${roomId} never synced`);
    await sleep(25);
  }
  await sleep(150); // anything still arriving as a live update
  const text = client.doc.getText('content').toJSON();
  client.stop();
  return text;
}

const rooms = Math.ceil(vus / roomSize);
const seen = new Map(); // vu -> sorted seqs
let total = 0;
const problems = [];
const ids = Array.from({ length: rooms }, (_, i) => `${run}-${i}`);
for (let i = 0; i < ids.length; i += 8) {
  const texts = await Promise.all(ids.slice(i, i + 8).map(readRoom));
  for (const [j, text] of texts.entries()) {
    const roomId = ids[i + j];
    const bytes = new TextEncoder().encode(text);
    for (const m of extractMarkers(bytes)) {
      total += 1;
      const list = seen.get(m.vu) ?? [];
      list.push(m.seq);
      seen.set(m.vu, list);
      if (Math.floor((m.vu - 1) / roomSize) !== Number(roomId.slice(run.length + 1))) {
        problems.push(`vu ${m.vu} found in the wrong room ${roomId}`);
      }
    }
  }
}

let lost = 0;
let duplicated = 0;
for (const [vu, list] of seen) {
  list.sort((a, b) => a - b);
  const unique = new Set(list);
  duplicated += list.length - unique.size;
  const max = list[list.length - 1];
  for (let s = 1; s <= max; s++) {
    if (!unique.has(s)) {
      lost += 1;
      if (problems.length < 20) problems.push(`vu ${vu} is missing edit ${s} (it has up to ${max})`);
    }
  }
}
const silent = [];
for (let vu = 1; vu <= vus; vu++) if (!seen.has(vu)) silent.push(vu);

console.log(`rooms read: ${rooms}, edits found: ${total}${expected === null ? '' : `, generator produced: ${expected}`}`);
console.log(`lost within a user's sequence: ${lost}, duplicated: ${duplicated}, users with no edits at all: ${silent.length}`);
const missingTail = expected === null ? 0 : expected - total;
if (missingTail !== 0) problems.push(`total differs from what the generator produced by ${missingTail}`);
for (const p of problems.slice(0, 20)) console.log('  ' + p);
const ok = lost === 0 && duplicated === 0 && silent.length === 0 && missingTail === 0 && problems.length === 0;
console.log(ok ? 'INTEGRITY OK' : 'INTEGRITY FAILED');
process.exit(ok ? 0 : 1);

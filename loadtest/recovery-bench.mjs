// Measures cold recovery: how long it takes to rebuild a room's Yjs document
// from Postgres (snapshot read + op-log replay) with nothing in memory and
// nothing in Redis.
//
// Usage (needs Docker, and `npm run build` first):
//   node loadtest/recovery-bench.mjs
//
// It starts a throwaway Postgres in a container, applies the repo's real
// migrations, builds documents by simulating typing, and times
// Persistence.recover() against them. Everything is on localhost, so the
// numbers exclude network latency to a managed database: add one round trip
// for the snapshot query and one for the ops query to estimate that.
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import pino from 'pino';
import { GenericContainer } from 'testcontainers';
import * as Y from 'yjs';
import { DocumentStore } from '../dist/persistence/documentStore.js';
import { Persistence } from '../dist/persistence/persistence.js';

const RUNS = 7;
const DOC_CHARS = 50_000;

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simulates a person typing: mostly appending short runs, sometimes jumping
 * back to fix something or deleting a few characters. Returns the update
 * produced by each edit, in order. */
function type(doc, edits, random) {
  const text = doc.getText('content');
  const updates = [];
  const onUpdate = (u) => updates.push(u);
  doc.on('update', onUpdate);
  const words = ['collab', 'strand', 'editor', 'the', 'and', 'merge', 'replica', 'cursor', 'offline', 'sync'];
  for (let i = 0; i < edits; i++) {
    const roll = random();
    if (roll < 0.1 && text.length > 5) {
      text.delete(Math.floor(random() * (text.length - 3)), 1 + Math.floor(random() * 3));
    } else {
      const at = roll < 0.25 ? Math.floor(random() * (text.length + 1)) : text.length;
      text.insert(at, words[Math.floor(random() * words.length)] + ' ');
    }
  }
  doc.off('update', onUpdate);
  return updates;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const container = await new GenericContainer('postgres:16-alpine')
  .withEnvironment({ POSTGRES_USER: 'strand', POSTGRES_PASSWORD: 'strand', POSTGRES_DB: 'strand' })
  .withExposedPorts(5432)
  .start();
const url = `postgres://strand:strand@${container.getHost()}:${container.getMappedPort(5432)}/strand`;
for (const deadline = Date.now() + 60_000; ; ) {
  const probe = new pg.Client({ connectionString: url });
  try {
    await probe.connect();
    await probe.end();
    break;
  } catch {
    await probe.end().catch(() => undefined);
    if (Date.now() > deadline) throw new Error('postgres did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
}
await runner({
  databaseUrl: url,
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
  migrationsTable: 'pgmigrations',
  direction: 'up',
  log: () => undefined,
});

const pool = new pg.Pool({ connectionString: url, max: 4 });
const store = new DocumentStore(pool);
const persistence = new Persistence({
  store,
  instanceId: 'bench',
  logger: pino({ level: 'silent' }),
  flushIntervalMs: 3_600_000,
  snapshotEveryOps: Number.MAX_SAFE_INTEGER,
  snapshotIntervalMs: 3_600_000,
  retentionVersions: 4,
  maxPendingOps: 1_000_000,
  maxPendingBytes: 1 << 30,
});

/** Builds a document of ~DOC_CHARS characters in Postgres.
 *  - snapshot: the content is in a snapshot, then `opRows` further rows of
 *    later edits are appended (each row merging a flush-worth of edits, as
 *    production does).
 *  - no snapshot: the whole content arrives as `opRows` op rows, which is
 *    what a document looks like before its first snapshot. */
async function build(id, { snapshot, opRows, editsPerRow = 8 }) {
  const random = rng(opRows + (snapshot ? 1 : 0) + 42);
  const doc = new Y.Doc();
  const initialEdits = Math.ceil(DOC_CHARS / 7);
  const initialUpdates = type(doc, initialEdits, random);
  await store.ensureDocument(id);

  let rows;
  if (snapshot) {
    await store.trySnapshot(id, 0, Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), new Uint8Array(16));
    rows = [];
    for (let r = 0; r < opRows; r++) rows.push(Y.mergeUpdates(type(doc, editsPerRow, random)));
  } else {
    const groupSize = Math.ceil(initialUpdates.length / opRows);
    rows = [];
    for (let i = 0; i < initialUpdates.length; i += groupSize) {
      rows.push(Y.mergeUpdates(initialUpdates.slice(i, i + groupSize)));
    }
  }
  for (let i = 0; i < rows.length; i += 500) await store.appendOps(id, rows.slice(i, i + 500), 'bench');
  return { chars: doc.getText('content').length, state: Y.encodeStateAsUpdate(doc), rows };
}

async function measure(id, expected) {
  const times = [];
  let last;
  for (let i = 0; i < RUNS; i++) {
    const doc = new Y.Doc();
    last = await persistence.recover(id, doc);
    times.push(last.ms);
    if (i === 0) {
      const same =
        Buffer.compare(Buffer.from(Y.encodeStateVector(doc)), Buffer.from(Y.encodeStateVector(expected))) === 0 &&
        doc.getText('content').toJSON() === expected.getText('content').toJSON();
      if (!same) throw new Error(`recovered state for ${id} does not match what was written`);
    }
  }
  return { ...last, min: Math.min(...times), median: median(times), max: Math.max(...times) };
}

const scenarios = [
  { name: 'snapshot only', opts: { snapshot: true, opRows: 0 } },
  { name: 'snapshot + 120 op rows', opts: { snapshot: true, opRows: 120 } },
  { name: 'snapshot + 1,000 op rows', opts: { snapshot: true, opRows: 1000 } },
  { name: 'snapshot + 10,000 op rows', opts: { snapshot: true, opRows: 10_000 } },
  { name: 'no snapshot, content as ~1,000 op rows', opts: { snapshot: false, opRows: 1000 } },
  { name: 'no snapshot, one op row per edit', opts: { snapshot: false, opRows: 7143 } },
];

const results = [];
for (const [i, scenario] of scenarios.entries()) {
  const id = `bench-${i}`;
  const built = await build(id, scenario.opts);
  const expected = new Y.Doc();
  Y.applyUpdate(expected, built.state);
  const r = await measure(id, expected);
  results.push({ scenario: scenario.name, chars: built.chars, ...r });
  console.error(`done: ${scenario.name}`);
}

console.log(`\nCold recovery of one room, ${RUNS} runs each (first run included), localhost Postgres`);
console.log(`node ${process.version}, ${os.cpus()[0]?.model}, ${os.cpus().length} cores, postgres:16-alpine in Docker\n`);
console.log('| Scenario | Doc chars | Snapshot | Op rows | Op bytes | min ms | median ms | max ms |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const r of results) {
  console.log(
    `| ${r.scenario} | ${r.chars.toLocaleString()} | ${r.snapshotBytes.toLocaleString()} B | ${r.opsReplayed.toLocaleString()} | ${r.opBytes.toLocaleString()} B | ${r.min.toFixed(1)} | ${r.median.toFixed(1)} | ${r.max.toFixed(1)} |`,
  );
}

await persistence.close();
await pool.end();
await container.stop();

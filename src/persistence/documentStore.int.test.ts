import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentStore } from './documentStore.js';
import { startTestPostgres, type TestPostgres } from './testPostgres.js';

const digest = new Uint8Array(16);

describe('DocumentStore (real Postgres)', () => {
  let pg: TestPostgres;
  let store: DocumentStore;

  beforeAll(async () => {
    pg = await startTestPostgres();
    store = new DocumentStore(pg.pool);
  }, 180_000);

  afterAll(async () => {
    await pg.stop();
  });

  beforeEach(async () => {
    await pg.reset();
  });

  async function advance(id: string, times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      const current = (await store.readSnapshot(id))!;
      await store.trySnapshot(id, current.snapshotVersion, new Uint8Array([i]), new Uint8Array([i]), digest);
    }
  }

  it('applies the real migrations: both tables exist', async () => {
    const tables = await pg.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
    const names = tables.rows.map((r: { tablename: string }) => r.tablename);
    expect(names).toContain('documents');
    expect(names).toContain('document_ops');
  });

  it('reports an unknown document as absent, and a new one as empty at version 0', async () => {
    expect(await store.load('nope')).toBeNull();
    await store.ensureDocument('doc');
    await store.ensureDocument('doc'); // idempotent
    expect(await store.load('doc')).toMatchObject({ snapshot: null, snapshotVersion: 0, ops: [] });
  });

  it('round-trips arbitrary binary payloads exactly, in a single batch', async () => {
    const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);
    const empty = new Uint8Array();
    await store.appendOps('doc', [everyByte, empty, new Uint8Array([0, 0, 0])], 'inst');
    const loaded = (await store.load('doc'))!;
    const sorted = loaded.ops.map((o) => Array.from(o)).sort((a, b) => a.length - b.length);
    expect(sorted).toEqual([[], [0, 0, 0], Array.from(everyByte)]);
  });

  it('creates the document row on the first write', async () => {
    await store.appendOps('fresh', [new Uint8Array([1])], 'inst');
    expect(await store.load('fresh')).toMatchObject({ snapshotVersion: 0 });
    expect(await store.opCount('fresh')).toBe(1);
  });

  it('tags each op with the version current at insert time, which the writer cannot choose', async () => {
    await store.ensureDocument('doc');
    await store.appendOps('doc', [new Uint8Array([1])], 'inst');
    await advance('doc', 3);
    await store.appendOps('doc', [new Uint8Array([2])], 'inst');
    const tags = await pg.pool.query<{ base_version: string }>(
      'SELECT base_version FROM document_ops WHERE doc_id = $1 ORDER BY base_version',
      ['doc'],
    );
    expect(tags.rows.map((r) => Number(r.base_version))).toEqual([0, 3]);
  });

  it('only accepts a snapshot against the version the writer last saw (compare-and-set)', async () => {
    await store.ensureDocument('doc');
    expect(await store.trySnapshot('doc', 0, new Uint8Array([1]), new Uint8Array([1]), digest)).toBe(1);
    // Another writer still believing the version is 0 loses, and changes nothing.
    expect(await store.trySnapshot('doc', 0, new Uint8Array([9]), new Uint8Array([9]), digest)).toBeNull();
    const stored = (await store.readSnapshot('doc'))!;
    expect(stored.snapshotVersion).toBe(1);
    expect(Array.from(stored.snapshot!)).toEqual([1]);
  });

  it('lets exactly one of many concurrent snapshot attempts win each version', async () => {
    await store.ensureDocument('doc');
    const attempts = await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.trySnapshot('doc', 0, new Uint8Array([i]), new Uint8Array([i]), digest)),
    );
    expect(attempts.filter((v) => v === 1)).toHaveLength(1);
    expect(attempts.filter((v) => v === null)).toHaveLength(24);
    expect((await store.readSnapshot('doc'))!.snapshotVersion).toBe(1);
  });

  it('compaction removes only ops tagged below the cutoff, and only for that document', async () => {
    await store.ensureDocument('a');
    await store.ensureDocument('b');
    await store.appendOps('a', [new Uint8Array([1])], 'i'); // tag 0
    await store.appendOps('b', [new Uint8Array([1])], 'i'); // tag 0
    await advance('a', 2);
    await store.appendOps('a', [new Uint8Array([2])], 'i'); // tag 2
    await advance('a', 1);
    await store.appendOps('a', [new Uint8Array([3])], 'i'); // tag 3

    expect(await store.compact('a', 3)).toBe(2); // tags 0 and 2 go; tag 3 stays
    expect(await store.opCount('a')).toBe(1);
    expect(await store.opCount('b')).toBe(1); // untouched
  });

  it('removes a document\'s ops when the document is deleted', async () => {
    await store.appendOps('doc', [new Uint8Array([1])], 'i');
    await pg.pool.query('DELETE FROM documents WHERE id = $1', ['doc']);
    expect(await store.opCount('doc')).toBe(0);
  });
});

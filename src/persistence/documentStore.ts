import type pg from 'pg';

export interface StoredSnapshot {
  snapshot: Uint8Array | null;
  snapshotVersion: number;
  stateVector: Uint8Array | null;
  deleteSetDigest: Uint8Array | null;
}

export interface LoadedDocument extends StoredSnapshot {
  /** Every op still in the log. Recovery replays all of them: they are
   * idempotent, so replaying ones a snapshot already contains is harmless,
   * and which ones those are is exactly what we cannot know cheaply. */
  ops: Uint8Array[];
}

function bytes(value: Buffer | null): Uint8Array | null {
  return value === null ? null : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * All SQL for documents and their op log. Raw queries, no ORM.
 *
 * Nothing here takes a lock across instances. Writers append rows, and the
 * only contended write is the snapshot, guarded by compare-and-set on
 * `snapshot_version` so the loser simply retries against the winner's result.
 */
export class DocumentStore {
  #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async ensureDocument(id: string): Promise<void> {
    await this.#pool.query('INSERT INTO documents (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
  }

  /** Null if the document has never been persisted. */
  async load(id: string): Promise<LoadedDocument | null> {
    const doc = await this.readSnapshot(id);
    if (doc === null) return null;
    const ops = await this.#pool.query<{ payload: Buffer }>('SELECT payload FROM document_ops WHERE doc_id = $1', [id]);
    return { ...doc, ops: ops.rows.map((row) => new Uint8Array(row.payload)) };
  }

  async readSnapshot(id: string): Promise<StoredSnapshot | null> {
    const result = await this.#pool.query<{
      snapshot: Buffer | null;
      snapshot_version: string;
      state_vector: Buffer | null;
      delete_set_digest: Buffer | null;
    }>('SELECT snapshot, snapshot_version, state_vector, delete_set_digest FROM documents WHERE id = $1', [id]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      snapshot: bytes(row.snapshot),
      snapshotVersion: Number(row.snapshot_version),
      stateVector: bytes(row.state_vector),
      deleteSetDigest: bytes(row.delete_set_digest),
    };
  }

  /**
   * Appends update rows. `base_version` is read from the documents table
   * inside this statement rather than passed in. A writer's own idea of the
   * current version can be arbitrarily stale (it may not have snapshotted or
   * read the row for minutes), and a stale tag makes the op look old enough
   * for compaction to delete before any snapshot contains it.
   */
  async appendOps(id: string, payloads: Uint8Array[], originInstance: string): Promise<void> {
    if (payloads.length === 0) return;
    const insert = () =>
      this.#pool.query(
        `INSERT INTO document_ops (doc_id, base_version, payload, origin_instance)
         SELECT d.id, d.snapshot_version, p.payload, $3
           FROM documents d CROSS JOIN unnest($2::bytea[]) AS p(payload)
          WHERE d.id = $1`,
        [id, payloads.map((p) => Buffer.from(p)), originInstance],
      );
    const result = await insert();
    if (result.rowCount === 0) {
      // The document row doesn't exist yet (first write for this document).
      await this.ensureDocument(id);
      await insert();
    }
  }

  /**
   * Writes a new snapshot only if nobody has advanced the version past
   * `expectedVersion`. Returns the new version, or null if another instance
   * got there first; the caller should re-read, merge, and try again.
   * Any instance may call this: there is no snapshotter to elect.
   */
  async trySnapshot(
    id: string,
    expectedVersion: number,
    snapshot: Uint8Array,
    stateVector: Uint8Array,
    deleteSetDigest: Uint8Array,
  ): Promise<number | null> {
    const next = expectedVersion + 1;
    const result = await this.#pool.query<{ snapshot_version: string }>(
      `UPDATE documents
          SET snapshot = $2, snapshot_version = $3, state_vector = $4,
              delete_set_digest = $5, updated_at = now()
        WHERE id = $1 AND snapshot_version < $3
        RETURNING snapshot_version`,
      [id, Buffer.from(snapshot), next, Buffer.from(stateVector), Buffer.from(deleteSetDigest)],
    );
    const row = result.rows[0];
    return row ? Number(row.snapshot_version) : null;
  }

  /** Deletes ops tagged below `belowVersion`. Returns how many. */
  async compact(id: string, belowVersion: number): Promise<number> {
    const result = await this.#pool.query('DELETE FROM document_ops WHERE doc_id = $1 AND base_version < $2', [
      id,
      belowVersion,
    ]);
    return result.rowCount ?? 0;
  }

  async opCount(id: string): Promise<number> {
    const result = await this.#pool.query<{ n: string }>('SELECT count(*) AS n FROM document_ops WHERE doc_id = $1', [id]);
    return Number(result.rows[0]?.n ?? 0);
  }
}

import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import * as Y from 'yjs';
import { PERSISTED_ORIGIN, type Room } from '../room/Room.js';
import type { DocumentStore } from './documentStore.js';

export interface PersistenceOptions {
  store: DocumentStore;
  instanceId: string;
  logger: Logger;
  /** How often buffered ops are written. This is the window in which a crash
   * of the originating instance loses ops from the log (not from memory on
   * other instances, and not from the next snapshot). */
  flushIntervalMs: number;
  /** Snapshot after this many document changes since the last one... */
  snapshotEveryOps: number;
  /** ...or this long after the first unsnapshotted change, whichever first. */
  snapshotIntervalMs: number;
  /** Compaction keeps ops tagged within this many snapshot versions of the
   * newest. See ADR 0004 for what this trades off. */
  retentionVersions: number;
  /** Bounds on one room's unwritten buffer. Past either, the buffer is
   * dropped and a snapshot is forced instead of letting memory grow while
   * Postgres is slow or down. */
  maxPendingOps: number;
  maxPendingBytes: number;
  /** How long joiners wait for the database before the room is served from
   * what peers have. Loading carries on in the background and merges in
   * whenever it arrives, so a slow database delays nothing but its own
   * contribution. Default 3000. */
  recoveryTimeoutMs?: number;
  random?: () => number;
}

export interface PersistenceStats {
  opsWritten: number;
  flushes: number;
  flushFailures: number;
  /** Ops discarded from the buffer on overflow; their content reaches the
   * database via the forced snapshot instead. */
  opsDropped: number;
  snapshots: number;
  /** A snapshot attempt that lost the compare-and-set to another instance. */
  snapshotConflicts: number;
  /** A snapshot skipped because the stored one already covered this state. */
  snapshotsSkipped: number;
  opsCompacted: number;
  lastSnapshotMs: number;
}

export interface RecoveryResult {
  snapshotBytes: number;
  opsReplayed: number;
  opBytes: number;
  ms: number;
}

function equalBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Hash of the delete set; same construction as the replicator's, so a
 * snapshot's digest and a live doc's are directly comparable. */
function deleteSetDigest(doc: Y.Doc): Uint8Array {
  const deletesOnly = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
  return createHash('sha256').update(deletesOnly).digest().subarray(0, 16);
}

/** Applies persisted state to `doc` in one transaction, so listeners see one
 * change rather than one per replayed op. */
export function applyPersisted(doc: Y.Doc, snapshot: Uint8Array | null, ops: Uint8Array[], logger?: Logger): void {
  Y.transact(
    doc,
    () => {
      if (snapshot) Y.applyUpdate(doc, snapshot, PERSISTED_ORIGIN);
      for (const op of ops) {
        try {
          Y.applyUpdate(doc, op, PERSISTED_ORIGIN);
        } catch (err) {
          // One corrupt row must not make the whole document unloadable.
          logger?.error({ err }, 'skipping an unreadable op during recovery');
        }
      }
    },
    PERSISTED_ORIGIN,
  );
}

interface RoomState {
  room: Room;
  pending: Uint8Array[];
  pendingBytes: number;
  /** Changes since our last snapshot, from any origin. */
  opsSinceSnapshot: number;
  /** Bumped on every change; compared against `cleanSeq` to know if a
   * snapshot is still owed. Remote and healed changes count: they are the
   * reason any instance, not just the originator, can persist a document. */
  updateSeq: number;
  cleanSeq: number;
  snapshotTimer: NodeJS.Timeout | undefined;
  onUpdate: (update: Uint8Array, origin: unknown) => void;
}

/**
 * Write-behind persistence for rooms on this instance.
 *
 * Nothing here is on the edit path. A document change is handled by pushing
 * bytes onto an in-memory buffer; Postgres is touched later, by timers.
 *
 * Who writes what:
 *  - OPS are written only for changes whose Yjs origin is a client connected
 *    to this instance. A change that arrived from a peer was already
 *    persisted (or is being) by the instance its client is on, so each edit
 *    is logged exactly once, with no election, lease, or content hash. (A
 *    hash would not even work: an instance applying a partly-known update
 *    emits only the new part, with different bytes.)
 *  - SNAPSHOTS may be written by any instance that holds unsnapshotted
 *    changes, from any origin. That covers the hole the origin rule opens:
 *    an op lost with its dying originator is still in the memory of the
 *    other instances, and they snapshot it. Partial, not total: if every
 *    holder dies before one snapshots, the change is gone.
 */
export class Persistence {
  readonly stats: PersistenceStats = {
    opsWritten: 0,
    flushes: 0,
    flushFailures: 0,
    opsDropped: 0,
    snapshots: 0,
    snapshotConflicts: 0,
    snapshotsSkipped: 0,
    opsCompacted: 0,
    lastSnapshotMs: 0,
  };

  #options: PersistenceOptions;
  #rooms = new Map<string, RoomState>();
  #chains = new Map<string, Promise<void>>();
  #flushTimer: NodeJS.Timeout | undefined;
  #random: () => number;
  #closed = false;

  constructor(options: PersistenceOptions) {
    this.#options = options;
    this.#random = options.random ?? Math.random;
    this.#flushTimer = setInterval(() => this.#flushAll(), options.flushIntervalMs);
  }

  /** Recovers the room from Postgres, then starts tracking its changes.
   * Resolves (never rejects) once the room holds whatever was persisted, or
   * once loading has failed and the room will simply start from what it
   * gets from peers: a database outage must not stop people editing. */
  attachRoom(room: Room): Promise<void> {
    return this.#serialize(room.id, async () => {
      if (this.#closed) return;
      const state: RoomState = {
        room,
        pending: [],
        pendingBytes: 0,
        opsSinceSnapshot: 0,
        updateSeq: 0,
        cleanSeq: 0,
        snapshotTimer: undefined,
        onUpdate: (update, origin) => this.#onUpdate(state, update, origin),
      };
      room.doc.on('update', state.onUpdate);
      this.#rooms.set(room.id, state);
      const recovery = (async () => {
        try {
          await this.#options.store.ensureDocument(room.id);
          const result = await this.recover(room.id, room.doc);
          this.#options.logger.info({ roomId: room.id, ...result }, 'room recovered from postgres');
        } catch (err) {
          this.#options.logger.error({ err, roomId: room.id }, 'recovery failed; serving without persisted state');
        }
      })();
      // Joiners wait for the database, but not forever. If it is slow or
      // down the room opens with whatever peers have, and the persisted
      // state merges in whenever (if ever) the read completes.
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.#options.logger.warn({ roomId: room.id }, 'recovery is slow; opening the room without it for now');
          resolve();
        }, this.#options.recoveryTimeoutMs ?? 3000);
      });
      await Promise.race([recovery, timedOut]);
      clearTimeout(timer);
    });
  }

  /** Loads a document's snapshot and replays its op log into `doc`. */
  async recover(docId: string, doc: Y.Doc): Promise<RecoveryResult> {
    const started = performance.now();
    const loaded = await this.#options.store.load(docId);
    if (loaded === null) return { snapshotBytes: 0, opsReplayed: 0, opBytes: 0, ms: performance.now() - started };
    applyPersisted(doc, loaded.snapshot, loaded.ops, this.#options.logger);
    return {
      snapshotBytes: loaded.snapshot?.length ?? 0,
      opsReplayed: loaded.ops.length,
      opBytes: loaded.ops.reduce((sum, op) => sum + op.length, 0),
      ms: performance.now() - started,
    };
  }

  /** Called when the last local member leaves and the room is dropped from
   * memory: write out anything still owed before the state goes away. */
  detachRoom(room: Room): Promise<void> {
    return this.#serialize(room.id, async () => {
      const state = this.#rooms.get(room.id);
      if (!state || state.room !== room) return;
      clearTimeout(state.snapshotTimer);
      room.doc.off('update', state.onUpdate);
      this.#rooms.delete(room.id);
      await this.#settle(state);
    });
  }

  #onUpdate(state: RoomState, update: Uint8Array, origin: unknown): void {
    if (origin === PERSISTED_ORIGIN || this.#closed) return;
    state.updateSeq += 1;
    state.opsSinceSnapshot += 1;

    // Only a change made by a client of this instance is ours to log.
    if (typeof origin === 'string') {
      state.pending.push(update);
      state.pendingBytes += update.length;
      if (state.pending.length > this.#options.maxPendingOps || state.pendingBytes > this.#options.maxPendingBytes) {
        this.stats.opsDropped += state.pending.length;
        state.pending = [];
        state.pendingBytes = 0;
        // The snapshot captures everything those ops held.
        this.#scheduleSnapshot(state, 0);
        return;
      }
    }

    if (state.opsSinceSnapshot >= this.#options.snapshotEveryOps) {
      this.#scheduleSnapshot(state, 0);
    } else if (state.snapshotTimer === undefined) {
      // Jittered so instances holding the same unsnapshotted change don't
      // all race to write it in the same instant.
      this.#scheduleSnapshot(state, this.#options.snapshotIntervalMs * (0.7 + 0.6 * this.#random()));
    }
  }

  #scheduleSnapshot(state: RoomState, delayMs: number): void {
    if (this.#closed) return;
    if (state.snapshotTimer !== undefined && delayMs > 0) return;
    clearTimeout(state.snapshotTimer);
    state.snapshotTimer = setTimeout(() => {
      state.snapshotTimer = undefined;
      // On its own chain, not behind the op flush: a snapshot supersedes the
      // buffered ops, so a stalled flush must not be able to hold it up.
      void this.#serialize(`${state.room.id}#snapshot`, async () => {
        if (this.#rooms.get(state.room.id) !== state) return;
        await this.#snapshot(state);
        if (state.updateSeq !== state.cleanSeq && !this.#closed) {
          this.#scheduleSnapshot(state, this.#options.snapshotIntervalMs * (0.7 + 0.6 * this.#random()));
        }
      });
    }, delayMs);
  }

  #flushAll(): void {
    for (const state of [...this.#rooms.values()]) {
      if (state.pending.length === 0) continue;
      void this.#serialize(`${state.room.id}#ops`, () => this.#flush(state));
    }
  }

  /** Writes the buffered ops as ONE row: Yjs updates merge, and a row per
   * keystroke would bloat the log for no benefit. On failure the ops go back
   * on the buffer to retry on the next tick. */
  async #flush(state: RoomState): Promise<void> {
    if (state.pending.length === 0) return;
    const batch = state.pending;
    const bytes = state.pendingBytes;
    state.pending = [];
    state.pendingBytes = 0;
    try {
      const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
      await this.#options.store.appendOps(state.room.id, [merged], this.#options.instanceId);
      this.stats.flushes += 1;
      this.stats.opsWritten += batch.length;
    } catch (err) {
      this.stats.flushFailures += 1;
      this.#options.logger.warn({ err, roomId: state.room.id }, 'op flush failed; will retry');
      // Anything buffered since is newer; put the failed batch back first.
      state.pending = [...batch, ...state.pending];
      state.pendingBytes += bytes;
      if (state.pending.length > this.#options.maxPendingOps || state.pendingBytes > this.#options.maxPendingBytes) {
        this.stats.opsDropped += state.pending.length;
        state.pending = [];
        state.pendingBytes = 0;
      }
    }
  }

  /**
   * Writes a snapshot that is the union of what Postgres already has and what
   * this instance holds. Merging rather than overwriting means a snapshot can
   * only ever add content: an instance that is behind, or just recovered
   * from an incomplete database read, can never shrink the stored state.
   * Guarded by compare-and-set on the version; a loser re-reads and merges
   * again, so concurrent snapshotters converge instead of clobbering.
   */
  async #snapshot(state: RoomState): Promise<void> {
    const { store, retentionVersions } = this.#options;
    const started = performance.now();
    const seqAtStart = state.updateSeq;

    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const stored = await store.readSnapshot(state.room.id);
        if (stored === null) {
          await store.ensureDocument(state.room.id);
          continue;
        }

        const merged = new Y.Doc();
        if (stored.snapshot) Y.applyUpdate(merged, stored.snapshot);
        Y.applyUpdate(merged, Y.encodeStateAsUpdate(state.room.doc));
        const stateVector = Y.encodeStateVector(merged);
        const digest = deleteSetDigest(merged);

        if (equalBytes(stateVector, stored.stateVector) && equalBytes(digest, stored.deleteSetDigest)) {
          // Another instance already persisted everything we hold.
          this.stats.snapshotsSkipped += 1;
          this.#markClean(state, seqAtStart);
          return;
        }

        const version = await store.trySnapshot(
          state.room.id,
          stored.snapshotVersion,
          Y.encodeStateAsUpdate(merged),
          stateVector,
          digest,
        );
        if (version === null) {
          this.stats.snapshotConflicts += 1;
          continue;
        }
        this.stats.snapshots += 1;
        this.stats.lastSnapshotMs = performance.now() - started;
        this.#markClean(state, seqAtStart);
        this.stats.opsCompacted += await store.compact(state.room.id, version - retentionVersions);
        return;
      }
      this.#options.logger.warn({ roomId: state.room.id }, 'snapshot kept losing the version race; will retry later');
    } catch (err) {
      this.#options.logger.warn({ err, roomId: state.room.id }, 'snapshot failed; will retry');
    }
  }

  #markClean(state: RoomState, seqAtStart: number): void {
    state.opsSinceSnapshot = 0;
    // Anything that changed while the snapshot was being written is still owed.
    if (state.updateSeq === seqAtStart) state.cleanSeq = state.updateSeq;
  }

  /** Flush and snapshot whatever a room still owes. */
  async #settle(state: RoomState): Promise<void> {
    await this.#serialize(`${state.room.id}#ops`, () => this.#flush(state));
    if (state.updateSeq !== state.cleanSeq) {
      await this.#serialize(`${state.room.id}#snapshot`, () => this.#snapshot(state));
    }
  }

  /** Per-document ordering: a room dropped and re-created on this instance
   * must finish writing before the new one reads, or it would recover a
   * stale view and miss what the old one held. */
  #serialize(id: string, op: () => Promise<void>): Promise<void> {
    const previous = this.#chains.get(id) ?? Promise.resolve();
    const next = previous.then(op, op);
    this.#chains.set(id, next);
    void next.finally(() => {
      if (this.#chains.get(id) === next) this.#chains.delete(id);
    });
    return next;
  }

  /** Graceful shutdown: write everything still owed, so a clean stop loses
   * nothing. A crash skips this, which is what the durability window is. */
  async close(): Promise<void> {
    clearInterval(this.#flushTimer);
    const states = [...this.#rooms.values()];
    for (const state of states) clearTimeout(state.snapshotTimer);
    await Promise.allSettled(states.map((state) => this.#serialize(state.room.id, () => this.#settle(state))));
    // Rooms already detached have their final write queued on the same
    // chains; wait for those too.
    await Promise.allSettled([...this.#chains.values()]);
    for (const state of states) state.room.doc.off('update', state.onUpdate);
    this.#rooms.clear();
    this.#closed = true;
  }

  /** Simulates the process dying: no flush, no snapshot. */
  crash(): void {
    this.#closed = true;
    clearInterval(this.#flushTimer);
    for (const state of this.#rooms.values()) clearTimeout(state.snapshotTimer);
    this.#rooms.clear();
  }

  /** Test hook: the buffered ops a crash would lose. */
  pendingOps(roomId: string): number {
    return this.#rooms.get(roomId)?.pending.length ?? 0;
  }
}

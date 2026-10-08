import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import * as Y from 'yjs';
import type { PresenceValue } from '../presence/types.js';
import {
  MessageType,
  decode,
  encodeDocUpdate,
  encodePresenceBroadcast,
  encodePresenceRemove,
  encodeSyncStep2,
} from '../protocol/index.js';
import { REMOTE_ORIGIN, type Room } from '../room/Room.js';
import type { FanoutBus } from './bus.js';
import type { HybridClock } from './clock.js';
import {
  DELETE_SET_DIGEST_BYTES,
  EnvelopeKind,
  decodeEnvelope,
  encodeFenceEnvelope,
  encodeFrameEnvelope,
  encodeReconcileEnvelope,
  type Envelope,
} from './envelope.js';
import type { PresenceStore } from './presenceStore.js';
import { instanceOfOwner, type SessionStore } from './sessionStore.js';

/** Bound on session-lease round trips that sit in the connect path or on a
 * heartbeat. A slow Redis must not stall a join; we degrade to local-only
 * identity checks instead (see claimSession). */
const SESSION_TIMEOUT_MS = 1000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export interface ReplicatorOptions {
  instanceId: string;
  bus: FanoutBus;
  store: PresenceStore;
  sessions: SessionStore;
  clock: HybridClock;
  logger: Logger;
  reconcileIntervalMs: number;
  joinSyncTimeoutMs: number;
  random?: () => number;
}

const channelFor = (roomId: string): string => `strand:room:${roomId}`;

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Hash of the document's delete set. encodeStateAsUpdate against the
 * doc's own state vector contains no structs, only the delete set, and the
 * delete set is encoded sorted and merged, so converged replicas produce
 * identical bytes. */
export function deleteSetDigest(doc: Y.Doc): Uint8Array {
  const deletesOnly = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
  return createHash('sha256').update(deletesOnly).digest().subarray(0, DELETE_SET_DIGEST_BYTES);
}

interface JoinWait {
  received: number;
  expected: number | null;
  settle: () => void;
}

/**
 * Keeps this instance's rooms converged with the same rooms on other
 * instances.
 *
 * Two mechanisms, and it matters which one is load-bearing:
 *
 *  - Pub/sub fan-out of each update is the OPTIMISATION. It makes the common
 *    case fast. It is lossy by nature (a briefly disconnected or slow
 *    subscriber silently misses messages), so nothing may depend on it.
 *  - Periodic reconciliation is the CORRECTNESS MECHANISM. Every
 *    reconcileIntervalMs each instance announces its state vector and
 *    delete-set digest for each room; a peer that has something the sender
 *    lacks replies with exactly that diff. Because Yjs updates are
 *    commutative and idempotent, applying a diff twice, late, or out of
 *    order is harmless, so divergence from any number of lost messages is
 *    repaired within about one interval of the network being healthy.
 *
 * Presence works the same way: frames for latency, and a periodic sync
 * against the Redis presence store as the repair path.
 */
export class Replicator {
  readonly instanceId: string;
  #bus: FanoutBus;
  #store: PresenceStore;
  #sessions: SessionStore;
  #onFence: (roomId: string, clientId: string, newOwnerId: string) => void = () => undefined;
  #clock: HybridClock;
  #logger: Logger;
  #reconcileIntervalMs: number;
  #joinSyncTimeoutMs: number;
  #random: () => number;
  #getRoom: (roomId: string) => Room | undefined = () => undefined;
  #attached = new Set<string>();
  #joins = new Map<string, JoinWait>();
  #roomOps = new Map<string, Promise<void>>();
  #inflight = new Set<Promise<unknown>>();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: ReplicatorOptions) {
    this.instanceId = options.instanceId;
    this.#bus = options.bus;
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#reconcileIntervalMs = options.reconcileIntervalMs;
    this.#joinSyncTimeoutMs = options.joinSyncTimeoutMs;
    this.#random = options.random ?? Math.random;
  }

  /** Gives the replicator a way to find live rooms and to tell the gateway
   * a connection has been fenced. Set by the gateway, which owns the room
   * manager the replicator is hooked into. */
  bind(
    getRoom: (roomId: string) => Room | undefined,
    onFence: (roomId: string, clientId: string, newOwnerId: string) => void,
  ): void {
    this.#getRoom = getRoom;
    this.#onFence = onFence;
  }

  start(): void {
    this.#scheduleTick();
  }

  // ---- room lifecycle ----------------------------------------------------

  /** Subscribes to the room and catches up with peers. The returned promise
   * is the room's `ready`: it never rejects, because a joiner must not be
   * stuck behind a broken Redis. It just resolves with whatever we have. */
  attachRoom(room: Room): Promise<void> {
    return this.#serialize(room.id, async () => {
      if (this.#closed) return;
      try {
        await this.#bus.subscribe(channelFor(room.id), (bytes) => this.#onMessage(room.id, bytes));
        this.#attached.add(room.id);
        await Promise.all([this.#loadPresence(room), this.#joinSync(room)]);
      } catch (err) {
        this.#logger.warn({ err, roomId: room.id }, 'room attach incomplete; serving local state');
      }
    });
  }

  detachRoom(roomId: string): Promise<void> {
    return this.#serialize(roomId, async () => {
      this.#attached.delete(roomId);
      if (this.#closed) return;
      try {
        await this.#bus.unsubscribe(channelFor(roomId));
      } catch (err) {
        this.#logger.warn({ err, roomId }, 'unsubscribe failed');
      }
    });
  }

  // ---- outbound ------------------------------------------------------------

  publishDocUpdate(roomId: string, update: Uint8Array): void {
    this.#publishFrame(roomId, encodeDocUpdate(update));
  }

  publishPresence(roomId: string, clientId: string, timestamp: number, value: PresenceValue): void {
    if (this.#closed) return;
    this.#track(this.#store.upsert(roomId, { clientId, timestamp, value }), 'presence upsert failed', roomId);
    this.#publishFrame(roomId, encodePresenceBroadcast(clientId, timestamp, value));
  }

  publishPresenceRemove(roomId: string, clientId: string, timestamp: number): void {
    if (this.#closed) return;
    this.#track(this.#store.remove(roomId, clientId), 'presence remove failed', roomId);
    this.#publishFrame(roomId, encodePresenceRemove(clientId, timestamp));
  }

  /** Called on every heartbeat pong. Re-stamps the entry so that, if Redis
   * lost it or a peer synthesised a removal for it, this newer add wins
   * everywhere. Not broadcast: peers pick the new timestamp up from the
   * store on their next sync, and viewers see no change. */
  refreshPresence(room: Room, clientId: string): void {
    const value = room.presence.get(clientId);
    if (!value || this.#closed) return;
    const timestamp = this.#clock.now();
    room.presence.add(clientId, value, timestamp, clientId);
    this.#track(this.#store.upsert(room.id, { clientId, timestamp, value }), 'presence refresh failed', room.id);
  }

  // ---- session identity ----------------------------------------------------

  /** Registers `ownerId` as the live connection for `clientId`, and if a
   * live connection on another instance held it, tells that instance to
   * close it. Never throws: with Redis unreachable the join proceeds, and
   * uniqueness is enforced only among connections on this instance until the
   * heartbeat check can run again. Refusing to let people connect because
   * the coordination layer is down would turn a partial outage into a total
   * one, which is the wrong trade for a collaboration tool. */
  async claimSession(roomId: string, clientId: string, ownerId: string): Promise<void> {
    if (this.#closed) return;
    try {
      const displaced = await withTimeout(this.#sessions.claim(roomId, clientId, ownerId), SESSION_TIMEOUT_MS);
      if (displaced === null || displaced === ownerId) return;
      const target = instanceOfOwner(displaced);
      if (target === this.instanceId) return; // the gateway fences local connections itself
      // Best effort and lossy, like everything on the bus. It is the fast
      // path only: the displaced connection finds out regardless at its next
      // heartbeat, when touchSession reports it no longer owns the lease.
      this.#track(
        this.#bus.publish(channelFor(roomId), encodeFenceEnvelope(this.instanceId, target, clientId, ownerId)),
        'fence publish failed',
        roomId,
      );
    } catch (err) {
      this.#logger.warn({ err, roomId, clientId }, 'session claim failed; identity unique per-instance only');
    }
  }

  /** False only if a different live connection now owns this client ID. A
   * Redis error answers true: an outage must not boot connected users. */
  async touchSession(roomId: string, clientId: string, ownerId: string): Promise<boolean> {
    if (this.#closed) return true;
    try {
      return await withTimeout(this.#sessions.touch(roomId, clientId, ownerId), SESSION_TIMEOUT_MS);
    } catch (err) {
      this.#logger.warn({ err, roomId, clientId }, 'session touch failed; assuming ownership');
      return true;
    }
  }

  releaseSession(roomId: string, clientId: string, ownerId: string): void {
    if (this.#closed) return;
    this.#track(this.#sessions.release(roomId, clientId, ownerId), 'session release failed', roomId);
  }

  /** A resuming client reclaims its old presence if that entry outlived the
   * connection that created it, which happens when the old connection was
   * fenced instead of departing cleanly. Re-stamped so it beats any removal
   * a peer synthesised while the client was gone. */
  async restorePresence(room: Room, clientId: string): Promise<void> {
    if (this.#closed) return;
    try {
      const mine = (await this.#store.list(room.id)).find((entry) => entry.clientId === clientId);
      if (!mine) return;
      this.#clock.observe(mine.timestamp);
      const timestamp = this.#clock.now();
      room.presence.add(clientId, mine.value, timestamp, clientId);
      this.#track(
        this.#store.upsert(room.id, { clientId, timestamp, value: mine.value }),
        'presence restore failed',
        room.id,
      );
    } catch (err) {
      this.#logger.warn({ err, roomId: room.id, clientId }, 'presence restore failed');
    }
  }

  // ---- inbound -------------------------------------------------------------

  #onMessage(roomId: string, bytes: Uint8Array): void {
    let env: Envelope;
    try {
      env = decodeEnvelope(bytes);
    } catch (err) {
      this.#logger.warn({ err, roomId }, 'dropping undecodable fan-out message');
      return;
    }
    // Explicit loop prevention. Redis delivers our own publishes back to us
    // because we are subscribed to the channel we publish on.
    if (env.origin === this.instanceId) return;
    if (env.target !== '' && env.target !== this.instanceId) return;

    if (env.kind === EnvelopeKind.Fence) {
      this.#onFence(roomId, env.clientId, env.newOwnerId);
      return;
    }

    const room = this.#getRoom(roomId);
    if (!room) return;

    if (env.kind === EnvelopeKind.Reconcile) {
      this.#onReconcile(room, env);
    } else {
      this.#onFrame(room, env);
    }
  }

  #onFrame(room: Room, env: Extract<Envelope, { kind: typeof EnvelopeKind.Frame }>): void {
    let msg;
    try {
      msg = decode(env.frame);
    } catch (err) {
      this.#logger.warn({ err, roomId: room.id }, 'dropping undecodable frame');
      return;
    }
    switch (msg.type) {
      case MessageType.DocUpdate:
        this.#applyRemoteUpdate(room, msg.update);
        return;
      case MessageType.SyncStep2:
        this.#applyRemoteUpdate(room, msg.update);
        this.#noteJoinReply(room.id, env.target === this.instanceId);
        return;
      case MessageType.PresenceBroadcast:
        // For a client connected here our own set is authoritative; an
        // instance never takes presence for its own clients from a peer.
        if (room.members.has(msg.clientId)) return;
        this.#clock.observe(msg.timestamp);
        if (room.applyRemotePresenceAdd(msg.clientId, msg.value, msg.timestamp)) {
          room.broadcast(encodePresenceBroadcast(msg.clientId, msg.timestamp, msg.value));
        }
        return;
      case MessageType.PresenceRemove:
        if (room.members.has(msg.clientId)) return;
        this.#clock.observe(msg.timestamp);
        if (room.applyRemotePresenceRemove(msg.clientId, msg.timestamp)) {
          room.broadcast(encodePresenceRemove(msg.clientId, msg.timestamp));
        }
        return;
      default:
        return;
    }
  }

  /** REMOTE_ORIGIN tells the room's update handler to deliver this to local
   * clients but not publish it again. */
  #applyRemoteUpdate(room: Room, update: Uint8Array): void {
    try {
      Y.applyUpdate(room.doc, update, REMOTE_ORIGIN);
    } catch (err) {
      this.#logger.warn({ err, roomId: room.id }, 'invalid remote update');
    }
  }

  #onReconcile(room: Room, env: Extract<Envelope, { kind: typeof EnvelopeKind.Reconcile }>): void {
    const converged =
      equalBytes(Y.encodeStateVector(room.doc), env.stateVector) &&
      equalBytes(deleteSetDigest(room.doc), env.deleteSetDigest);
    if (converged && !env.isJoin) return;

    let diff: Uint8Array;
    try {
      diff = Y.encodeStateAsUpdate(room.doc, env.stateVector);
    } catch (err) {
      this.#logger.warn({ err, roomId: room.id }, 'invalid state vector in reconcile');
      return;
    }
    // Sent even when the diff has no structs: the update always carries the
    // whole delete set, which is how a lost deletion gets repaired.
    this.#track(
      this.#bus.publish(channelFor(room.id), encodeFrameEnvelope(this.instanceId, env.origin, encodeSyncStep2(diff))),
      'reconcile reply failed',
      room.id,
    );
  }

  // ---- join catch-up -------------------------------------------------------

  async #joinSync(room: Room): Promise<void> {
    const wait: JoinWait = { received: 0, expected: null, settle: () => undefined };
    const done = new Promise<void>((resolve) => {
      wait.settle = resolve;
    });
    this.#joins.set(room.id, wait);
    const timeout = setTimeout(wait.settle, this.#joinSyncTimeoutMs);
    try {
      // PUBLISH reports how many subscribers it reached. Ours counts as one,
      // so anything above that is a peer that will answer and is worth
      // waiting for; if we are alone there is nothing to wait for.
      const receivers = await this.#publishReconcile(room, true);
      wait.expected = Math.max(0, receivers - 1);
      if (wait.received >= wait.expected) wait.settle();
      await done;
    } finally {
      clearTimeout(timeout);
      this.#joins.delete(room.id);
    }
  }

  #noteJoinReply(roomId: string, addressedToUs: boolean): void {
    const wait = this.#joins.get(roomId);
    if (!wait || !addressedToUs) return;
    wait.received += 1;
    if (wait.expected !== null && wait.received >= wait.expected) wait.settle();
  }

  #publishReconcile(room: Room, isJoin: boolean): Promise<number> {
    return this.#bus.publish(
      channelFor(room.id),
      encodeReconcileEnvelope(
        this.instanceId,
        '',
        isJoin,
        Y.encodeStateVector(room.doc),
        deleteSetDigest(room.doc),
      ),
    );
  }

  // ---- presence sync -------------------------------------------------------

  async #loadPresence(room: Room): Promise<void> {
    for (const entry of await this.#store.list(room.id)) {
      if (room.members.has(entry.clientId)) continue;
      this.#clock.observe(entry.timestamp);
      if (room.applyRemotePresenceAdd(entry.clientId, entry.value, entry.timestamp)) {
        room.broadcast(encodePresenceBroadcast(entry.clientId, entry.timestamp, entry.value));
      }
    }
  }

  /** Repairs presence against the store. Remote entries missing from the
   * store (expired, or removed while we missed the frame) are removed with
   * the timestamp we last saw for them, taken BEFORE reading the store. A
   * removal stamped at the observed add timestamp beats exactly that add
   * (remove wins ties) and nothing newer, so an update that races this sync
   * survives instead of being clobbered. */
  async #syncPresence(room: Room): Promise<void> {
    const seen = room.presence.entries().filter((entry) => !room.members.has(entry.elementId));
    const live = await this.#store.list(room.id);
    const liveIds = new Set(live.map((entry) => entry.clientId));

    for (const entry of live) {
      if (room.members.has(entry.clientId)) continue;
      this.#clock.observe(entry.timestamp);
      if (room.applyRemotePresenceAdd(entry.clientId, entry.value, entry.timestamp)) {
        room.broadcast(encodePresenceBroadcast(entry.clientId, entry.timestamp, entry.value));
      }
    }
    for (const entry of seen) {
      if (liveIds.has(entry.elementId)) continue;
      if (room.applyRemotePresenceRemove(entry.elementId, entry.timestamp)) {
        room.broadcast(encodePresenceRemove(entry.elementId, entry.timestamp));
      }
    }
  }

  // ---- periodic reconciliation ---------------------------------------------

  #scheduleTick(): void {
    if (this.#closed) return;
    // Jittered so a fleet restarted together doesn't announce in lockstep.
    const delay = this.#reconcileIntervalMs * (0.8 + 0.4 * this.#random());
    this.#timer = setTimeout(() => {
      void this.#tick().finally(() => this.#scheduleTick());
    }, delay);
  }

  async #tick(): Promise<void> {
    for (const roomId of [...this.#attached]) {
      const room = this.#getRoom(roomId);
      if (!room || this.#closed) continue;
      try {
        await Promise.all([this.#publishReconcile(room, false), this.#syncPresence(room)]);
      } catch (err) {
        this.#logger.warn({ err, roomId }, 'reconcile tick failed');
      }
    }
  }

  // ---- plumbing --------------------------------------------------------------

  #publishFrame(roomId: string, frame: Uint8Array): void {
    if (this.#closed) return;
    this.#track(
      this.#bus.publish(channelFor(roomId), encodeFrameEnvelope(this.instanceId, '', frame)),
      'publish failed',
      roomId,
    );
  }

  /** Fire-and-forget with accounting: failures are logged, never thrown
   * into the edit path, and close() can wait for in-flight work. */
  #track(work: Promise<unknown>, message: string, roomId: string): void {
    const tracked = work.catch((err: unknown) => this.#logger.warn({ err, roomId }, message));
    this.#inflight.add(tracked);
    void tracked.finally(() => this.#inflight.delete(tracked));
  }

  /** Subscribe/unsubscribe for the same room must not interleave: a room
   * destroyed and immediately recreated would otherwise race its own
   * unsubscribe against the new subscribe and end up deaf. */
  #serialize(roomId: string, op: () => Promise<void>): Promise<void> {
    const previous = this.#roomOps.get(roomId) ?? Promise.resolve();
    const next = previous.then(op, op);
    this.#roomOps.set(roomId, next);
    void next.finally(() => {
      if (this.#roomOps.get(roomId) === next) this.#roomOps.delete(roomId);
    });
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    await Promise.allSettled([...this.#inflight]);
    await this.#bus.close();
  }

  /** Simulates the process being killed: no goodbyes reach Redis. */
  crash(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#bus.crash();
  }
}

import { createServer, type Server } from 'node:http';
import net from 'node:net';
import pino from 'pino';
import { WebSocket } from 'ws';
import type * as Y from 'yjs';
import type { Config } from '../config.js';
import { baseConfig } from '../gateway/testSupport.js';
import { GatewayServer } from '../gateway/server.js';
import type { PresenceValue } from '../presence/types.js';
import { MessageType, decode } from '../protocol/index.js';
import type { ConnectionState, ReconnectPolicy } from '../protocol/reconnect.js';
import { CollabClient } from '../client/core.js';
import type { ClientSocket, Scheduler } from '../client/types.js';
import { RedisBus, connectRedis, type FanoutBus } from './bus.js';
import { HybridClock } from './clock.js';
import { EnvelopeKind, decodeEnvelope } from './envelope.js';
import { PresenceStore } from './presenceStore.js';
import { Replicator } from './replicator.js';
import { DocumentStore } from '../persistence/documentStore.js';
import { Persistence, type PersistenceOptions } from '../persistence/persistence.js';
import type pg from 'pg';
import { SessionStore } from './sessionStore.js';

const logger = pino({ level: 'silent' });

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function waitUntil(predicate: () => boolean, timeoutMs: number, what = 'condition'): Promise<number> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Date.now() - start;
}

/**
 * Wraps the real Redis bus with fault injection. Messages are still
 * published to and delivered by real Redis; the wrapper only discards some
 * of what Redis delivers to this instance, which is exactly what a
 * subscriber that was briefly disconnected, or fell behind its
 * client-output-buffer-limit, experiences: Redis considered it delivered,
 * the application never saw it.
 */
export class LossyBus implements FanoutBus {
  /** Probability in [0, 1] that an inbound message is silently dropped. */
  dropRate = 0;
  dropped = 0;
  readonly published: Uint8Array[] = [];
  #inner: FanoutBus;
  #random: () => number;

  constructor(inner: FanoutBus, random: () => number = Math.random) {
    this.#inner = inner;
    this.#random = random;
  }

  publish(channel: string, bytes: Uint8Array): Promise<number> {
    this.published.push(bytes);
    return this.#inner.publish(channel, bytes);
  }

  subscribe(channel: string, handler: (bytes: Uint8Array) => void): Promise<void> {
    return this.#inner.subscribe(channel, (bytes) => {
      if (this.dropRate > 0 && this.#random() < this.dropRate) {
        this.dropped += 1;
        return;
      }
      handler(bytes);
    });
  }

  unsubscribe(channel: string): Promise<void> {
    return this.#inner.unsubscribe(channel);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  crash(): void {
    this.#inner.crash();
  }

  /** Number of DocUpdate frames this instance published (as opposed to
   * reconcile traffic), for asserting nothing gets re-published. */
  docUpdatePublishes(): number {
    return this.published.filter((bytes) => {
      const env = decodeEnvelope(bytes);
      return env.kind === EnvelopeKind.Frame && decode(env.frame).type === MessageType.DocUpdate;
    }).length;
  }
}

/** A TCP proxy in front of Redis whose connections can be cut and later
 * allowed again, to partition one instance from Redis for real: its
 * sockets die, reconnects fail, then succeed after heal(). */
export class TcpProxy {
  port = 0;
  #server: net.Server;
  #sockets = new Set<net.Socket>();
  #blocked = false;

  constructor(targetHost: string, targetPort: number) {
    this.#server = net.createServer((client) => {
      if (this.#blocked) {
        client.destroy();
        return;
      }
      const upstream = net.connect(targetPort, targetHost);
      for (const socket of [client, upstream]) {
        this.#sockets.add(socket);
        socket.on('close', () => this.#sockets.delete(socket));
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }

  static async start(targetHost: string, targetPort: number): Promise<TcpProxy> {
    const proxy = new TcpProxy(targetHost, targetPort);
    await new Promise<void>((resolve) => proxy.#server.listen(0, '127.0.0.1', resolve));
    const address = proxy.#server.address();
    if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
    proxy.port = address.port;
    return proxy;
  }

  get url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  sever(): void {
    this.#blocked = true;
    for (const socket of this.#sockets) socket.destroy();
  }

  heal(): void {
    this.#blocked = false;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

export interface Instance {
  id: string;
  url: string;
  bus: LossyBus;
  replicator: Replicator;
  gateway: GatewayServer;
  /** Present when the instance was started with a Postgres pool. */
  persistence: Persistence | undefined;
  /** Graceful stop, as on SIGTERM. */
  stop(): Promise<void>;
  /** Process death: nothing reaches Redis on the way out. */
  kill(): Promise<void>;
}

export const FAST_TIMINGS: Partial<Config> = {
  reconcileIntervalMs: 100,
  joinSyncTimeoutMs: 500,
  presenceTtlMs: 900,
  heartbeatIntervalMs: 150,
  heartbeatMaxMissedPongs: 5,
};

export interface InstancePersistence {
  pool: pg.Pool;
  overrides?: Partial<PersistenceOptions>;
  /** Wraps the store, e.g. to stall writes. */
  wrapStore?: (store: DocumentStore) => DocumentStore;
}

export async function startInstance(
  redisUrl: string,
  id: string,
  overrides: Partial<Config> = {},
  random?: () => number,
  persistenceSetup?: InstancePersistence,
): Promise<Instance> {
  const config = baseConfig({ ...FAST_TIMINGS, instanceId: id, redisUrl, ...overrides });
  const pub = await connectRedis(redisUrl, { failFast: true, logger });
  const sub = await connectRedis(redisUrl, { failFast: false, logger });
  const data = await connectRedis(redisUrl, { failFast: true, logger });
  const bus = new LossyBus(new RedisBus(pub, sub, logger), random);
  const replicator = new Replicator({
    instanceId: id,
    bus,
    store: new PresenceStore(data, config.presenceTtlMs),
    sessions: new SessionStore(data, config.presenceTtlMs),
    clock: new HybridClock(),
    logger,
    reconcileIntervalMs: config.reconcileIntervalMs,
    joinSyncTimeoutMs: config.joinSyncTimeoutMs,
    ...(random ? { random } : {}),
  });
  let persistence: Persistence | undefined;
  if (persistenceSetup) {
    const baseStore = new DocumentStore(persistenceSetup.pool);
    persistence = new Persistence({
      store: persistenceSetup.wrapStore ? persistenceSetup.wrapStore(baseStore) : baseStore,
      instanceId: id,
      logger,
      flushIntervalMs: config.persistFlushIntervalMs,
      snapshotEveryOps: config.snapshotEveryOps,
      snapshotIntervalMs: config.snapshotIntervalMs,
      retentionVersions: config.opRetentionVersions,
      maxPendingOps: config.maxPendingOps,
      maxPendingBytes: 8 * 1024 * 1024,
      ...(random ? { random } : {}),
      ...persistenceSetup.overrides,
    });
  }
  const httpServer: Server = createServer();
  const gateway = new GatewayServer({
    server: httpServer,
    config,
    logger,
    fanout: replicator,
    ...(persistence ? { persistence } : {}),
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');

  const closeHttp = () => new Promise<void>((resolve) => httpServer.close(() => resolve()));
  return {
    id,
    url: `ws://127.0.0.1:${address.port}/ws`,
    bus,
    replicator,
    gateway,
    persistence,
    async stop() {
      await gateway.shutdown();
      data.disconnect();
      await closeHttp();
    },
    async kill() {
      // Cut Redis first so the shutdown below cannot deliver the goodbyes
      // (presence removals) a dead process never would.
      replicator.crash();
      persistence?.crash();
      data.disconnect();
      await gateway.shutdown();
      await closeHttp();
    },
  };
}

export interface ResilientClientOptions {
  roomId: string;
  /** Called once per connection attempt. A load balancer with no
   * stickiness is modelled by returning a different instance each time. */
  pickUrl: (attempt: number) => string;
  doc?: Y.Doc;
  random?: () => number;
  policy?: ReconnectPolicy;
  protocolVersion?: number;
  resumeToken?: Uint8Array | null;
}

/** Real time, handed to the core as its scheduler. */
const systemScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * The shipped client core (src/client/core.ts) on Node: `ws` for sockets and
 * the system clock for time. This is deliberately a thin shell. The
 * handshake, resume, sync, backoff, and liveness logic it exercises is the
 * very code the browser runs, not a parallel implementation of it, so a
 * green integration suite means something about the thing that ships.
 */
export class ResilientClient {
  readonly core: CollabClient;
  #lastSocket: WebSocket | null = null;
  #stoppedByUser = false;

  constructor(options: ResilientClientOptions) {
    this.core = new CollabClient({
      roomId: options.roomId,
      url: options.pickUrl,
      socketFactory: (url) => {
        const socket = new WebSocket(url);
        this.#lastSocket = socket;
        return socket as unknown as ClientSocket;
      },
      scheduler: systemScheduler,
      random: options.random ?? Math.random,
      policy: options.policy ?? { baseMs: 10, capMs: 80, immediateJitterMs: 10 },
      ...(options.doc ? { doc: options.doc } : {}),
      ...(options.protocolVersion !== undefined ? { protocolVersion: options.protocolVersion } : {}),
      ...(options.resumeToken ? { resumeToken: options.resumeToken } : {}),
    });
  }

  get doc(): Y.Doc {
    return this.core.doc;
  }
  get state(): ConnectionState {
    return this.core.getSnapshot().state;
  }
  get clientId(): string {
    return this.core.getSnapshot().clientId;
  }
  get resumed(): boolean {
    return this.core.getSnapshot().resumed;
  }
  get token(): Uint8Array | null {
    return this.core.token;
  }
  get connectAttempts(): number {
    return this.core.stats.connectAttempts;
  }
  get resumedFlags(): readonly boolean[] {
    return this.core.stats.resumedFlags;
  }
  get closeCodes(): readonly number[] {
    return this.core.stats.closeCodes;
  }
  get bytesSent(): number {
    return this.core.stats.bytesSent;
  }
  get bytesReceived(): number {
    return this.core.stats.bytesReceived;
  }
  /** Everyone else's presence, keyed by client ID. */
  get presence(): Map<string, PresenceValue> {
    return new Map(this.core.getSnapshot().peers.map((peer) => [peer.clientId, peer.value]));
  }
  /** The most recent close code the server (or network) gave, or 1000 if this
   * client closed itself; null while it has not been closed. */
  get closeCode(): number | null {
    return this.core.stats.closeCodes.at(-1) ?? (this.#stoppedByUser ? 1000 : null);
  }
  get text(): string {
    return this.doc.getText('content').toJSON();
  }

  start(): void {
    this.core.start();
  }

  insert(index: number, text: string): void {
    this.doc.getText('content').insert(index, text);
  }

  delete(index: number, length: number): void {
    this.doc.getText('content').delete(index, length);
  }

  setPresence(value: PresenceValue): void {
    this.core.setPresence(value);
  }

  /** Cuts the transport with no close handshake, like a dropped network. */
  killSocket(): void {
    this.#lastSocket?.terminate();
  }

  manualReconnect(): void {
    this.core.manualReconnect();
  }

  async connected(timeoutMs = 5000): Promise<void> {
    await waitUntil(() => this.state.status === 'connected', timeoutMs, 'client to be connected');
  }

  close(): void {
    this.#stoppedByUser = true;
    this.core.stop();
  }
}

/**
 * A client for tests that just want to be a participant in a room: connects
 * on construction and exposes `ready` for "the initial sync has landed".
 * Reconnects like any client, so the room it joins sees the real behaviour.
 */
export class TestClient extends ResilientClient {
  readonly ready: Promise<void>;

  constructor(url: string, roomId: string, doc?: Y.Doc, resumeToken?: Uint8Array) {
    super({
      roomId,
      pickUrl: () => url,
      ...(doc ? { doc } : {}),
      ...(resumeToken ? { resumeToken } : {}),
    });
    this.ready = new Promise<void>((resolve) => {
      const done = () => this.core.getSnapshot().synced;
      if (done()) return resolve();
      const unsubscribe = this.core.subscribe(() => {
        if (done()) {
          unsubscribe();
          resolve();
        }
      });
    });
    this.start();
  }
}

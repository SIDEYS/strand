import { createServer, type Server } from 'node:http';
import net from 'node:net';
import pino from 'pino';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import type { Config } from '../config.js';
import { baseConfig } from '../gateway/testSupport.js';
import { GatewayServer } from '../gateway/server.js';
import type { PresenceValue } from '../presence/types.js';
import {
  MessageType,
  PROTOCOL_VERSION,
  decode,
  encodeDocUpdate,
  encodeHello,
  encodePong,
  encodePresenceUpdate,
  encodeSyncStep1,
} from '../protocol/index.js';
import {
  step,
  type ConnectionEvent,
  type ConnectionState,
  type ReconnectPolicy,
} from '../protocol/reconnect.js';
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

/** A Yjs update with no structs and an empty delete set is two bytes. */
const EMPTY_UPDATE_BYTES = 2;

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
}

/**
 * A client that reconnects on its own, built on the same pure state machine
 * the browser client will use (protocol/reconnect.ts), carrying its resume
 * token across connections. Test-only for now; it exists to prove the whole
 * loop: kill the socket, back off, land on a different instance, resume the
 * identity, and resync only what was missed.
 */
export class ResilientClient {
  readonly doc: Y.Doc;
  readonly presence = new Map<string, PresenceValue>();
  state: ConnectionState = { status: 'idle' };
  clientId = '';
  token: Uint8Array | null = null;
  connectAttempts = 0;
  /** One entry per completed handshake: was it a resume? */
  readonly resumedFlags: boolean[] = [];
  readonly closeCodes: number[] = [];
  /** Bytes sent / received on the current connection, from HELLO onward. */
  bytesSent = 0;
  bytesReceived = 0;

  #options: ResilientClientOptions;
  #random: () => number;
  #policy: ReconnectPolicy;
  #ws: WebSocket | null = null;
  #timer: NodeJS.Timeout | undefined;
  #lastPresence: PresenceValue | null = null;
  #onUpdate: (update: Uint8Array, origin: unknown) => void;
  #closed = false;

  constructor(options: ResilientClientOptions) {
    this.#options = options;
    this.doc = options.doc ?? new Y.Doc();
    this.#random = options.random ?? Math.random;
    this.#policy = options.policy ?? { baseMs: 10, capMs: 80, immediateJitterMs: 10 };
    this.#onUpdate = (update, origin) => {
      if (origin === 'remote' || this.state.status !== 'connected') return;
      this.#send(encodeDocUpdate(update));
    };
    this.doc.on('update', this.#onUpdate);
  }

  get text(): string {
    return this.doc.getText('content').toJSON();
  }

  start(): void {
    this.#dispatch({ type: 'start' });
  }

  insert(index: number, text: string): void {
    this.doc.getText('content').insert(index, text);
  }

  setPresence(value: PresenceValue): void {
    this.#lastPresence = value;
    if (this.state.status === 'connected') this.#send(encodePresenceUpdate(value));
  }

  /** Cuts the transport with no close handshake, like a dropped network. */
  killSocket(): void {
    this.#ws?.terminate();
  }

  manualReconnect(): void {
    this.#dispatch({ type: 'manual-reconnect' });
  }

  async connected(timeoutMs = 5000): Promise<void> {
    await waitUntil(() => this.state.status === 'connected', timeoutMs, 'client to be connected');
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.doc.off('update', this.#onUpdate);
    this.#ws?.close();
  }

  #dispatch(event: ConnectionEvent): void {
    if (this.#closed) return;
    const { state, effect } = step(this.state, event, this.#random, this.#policy);
    this.state = state;
    switch (effect.kind) {
      case 'connect':
        clearTimeout(this.#timer);
        this.#open();
        break;
      case 'schedule-retry':
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.#dispatch({ type: 'retry-due' }), effect.delayMs);
        break;
      case 'cancel-retry':
        clearTimeout(this.#timer);
        break;
      case 'none':
        break;
    }
  }

  #send(bytes: Uint8Array): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    this.bytesSent += bytes.length;
    this.#ws.send(bytes);
  }

  #open(): void {
    this.connectAttempts += 1;
    this.bytesSent = 0;
    this.bytesReceived = 0;
    const ws = new WebSocket(this.#options.pickUrl(this.connectAttempts));
    this.#ws = ws;
    ws.once('open', () => {
      this.#send(
        encodeHello(this.#options.roomId, this.#options.protocolVersion ?? PROTOCOL_VERSION, this.token ?? undefined),
      );
    });
    ws.on('message', (data) => {
      if (ws !== this.#ws) return;
      const bytes = new Uint8Array(data as Buffer);
      this.bytesReceived += bytes.length;
      const msg = decode(bytes);
      switch (msg.type) {
        case MessageType.Welcome:
          this.clientId = msg.clientId;
          this.resumedFlags.push(msg.resumed);
          this.#dispatch({ type: 'welcome' });
          this.#send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
          // Presence is soft state that doesn't always survive a gap, so
          // announce again on every connect. Cheap, and idempotent.
          if (this.#lastPresence) this.#send(encodePresenceUpdate(this.#lastPresence));
          break;
        case MessageType.ResumeToken:
          this.token = msg.token;
          break;
        case MessageType.SyncStep2:
        case MessageType.DocUpdate:
          Y.applyUpdate(this.doc, msg.update, 'remote');
          break;
        case MessageType.SyncStep1: {
          const missing = Y.encodeStateAsUpdate(this.doc, msg.stateVector);
          if (missing.length > EMPTY_UPDATE_BYTES) this.#send(encodeDocUpdate(missing));
          break;
        }
        case MessageType.Ping:
          this.#send(encodePong());
          break;
        case MessageType.PresenceBroadcast:
          this.presence.set(msg.clientId, msg.value);
          break;
        case MessageType.PresenceRemove:
          this.presence.delete(msg.clientId);
          break;
        default:
          break;
      }
    });
    ws.on('close', (code) => {
      if (ws !== this.#ws) return; // a socket we've already replaced
      this.closeCodes.push(code);
      this.#dispatch({ type: 'closed', code });
    });
    ws.on('error', () => undefined); // surfaced as a close event
  }
}

/** Stand-in for the Phase 6 browser client: a Yjs doc wired to the real
 * protocol. Reconnecting with the same `doc` models a client that kept its
 * local state (and any offline edits) across the gap. */
export class TestClient {
  readonly ws: WebSocket;
  readonly doc: Y.Doc;
  readonly presence = new Map<string, PresenceValue>();
  clientId = '';
  resumed = false;
  /** The latest resume token the server sent. */
  token: Uint8Array | null = null;
  /** Set once the socket closes. */
  closeCode: number | null = null;
  ready: Promise<void>;
  #onUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(url: string, roomId: string, doc: Y.Doc = new Y.Doc(), resumeToken?: Uint8Array) {
    this.doc = doc;
    this.ws = new WebSocket(url);
    this.ws.on('close', (code) => (this.closeCode = code));
    this.ready = new Promise((resolve) => {
      this.ws.once('open', () => this.ws.send(encodeHello(roomId, PROTOCOL_VERSION, resumeToken)));
      this.ws.on('message', (data) => {
        const msg = decode(new Uint8Array(data as Buffer));
        switch (msg.type) {
          case MessageType.Welcome:
            this.clientId = msg.clientId;
            this.resumed = msg.resumed;
            this.ws.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
            break;
          case MessageType.ResumeToken:
            this.token = msg.token;
            break;
          case MessageType.SyncStep2:
            Y.applyUpdate(this.doc, msg.update, 'remote');
            resolve();
            break;
          case MessageType.SyncStep1: {
            // The server's state vector: send back only what it lacks.
            const missing = Y.encodeStateAsUpdate(this.doc, msg.stateVector);
            if (missing.length > EMPTY_UPDATE_BYTES) this.ws.send(encodeDocUpdate(missing));
            break;
          }
          case MessageType.DocUpdate:
            Y.applyUpdate(this.doc, msg.update, 'remote');
            break;
          case MessageType.Ping:
            this.ws.send(encodePong());
            break;
          case MessageType.PresenceBroadcast:
            this.presence.set(msg.clientId, msg.value);
            break;
          case MessageType.PresenceRemove:
            this.presence.delete(msg.clientId);
            break;
          default:
            break;
        }
      });
    });
    this.#onUpdate = (update, origin) => {
      if (origin === 'remote' || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(encodeDocUpdate(update));
    };
    this.doc.on('update', this.#onUpdate);
  }

  get text(): string {
    return this.doc.getText('content').toJSON();
  }

  insert(index: number, text: string): void {
    this.doc.getText('content').insert(index, text);
  }

  delete(index: number, length: number): void {
    this.doc.getText('content').delete(index, length);
  }

  setPresence(value: PresenceValue): void {
    this.ws.send(encodePresenceUpdate(value));
  }

  /** Detaches from the doc so it can be handed to a new connection. */
  close(): void {
    this.doc.off('update', this.#onUpdate);
    this.ws.close();
  }
}

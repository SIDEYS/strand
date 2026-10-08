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
  decode,
  encodeDocUpdate,
  encodeHello,
  encodePong,
  encodePresenceUpdate,
  encodeSyncStep1,
} from '../protocol/index.js';
import { RedisBus, connectRedis, type FanoutBus } from './bus.js';
import { HybridClock } from './clock.js';
import { EnvelopeKind, decodeEnvelope } from './envelope.js';
import { PresenceStore } from './presenceStore.js';
import { Replicator } from './replicator.js';
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

export async function startInstance(
  redisUrl: string,
  id: string,
  overrides: Partial<Config> = {},
  random?: () => number,
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
  const httpServer: Server = createServer();
  const gateway = new GatewayServer({ server: httpServer, config, logger, fanout: replicator });
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
    async stop() {
      await gateway.shutdown();
      data.disconnect();
      await closeHttp();
    },
    async kill() {
      // Cut Redis first so the shutdown below cannot deliver the goodbyes
      // (presence removals) a dead process never would.
      replicator.crash();
      data.disconnect();
      await gateway.shutdown();
      await closeHttp();
    },
  };
}

/** Stand-in for the Phase 6 browser client: a Yjs doc wired to the real
 * protocol. Reconnecting with the same `doc` models a client that kept its
 * local state (and any offline edits) across the gap. */
export class TestClient {
  readonly ws: WebSocket;
  readonly doc: Y.Doc;
  readonly presence = new Map<string, PresenceValue>();
  clientId = '';
  ready: Promise<void>;
  #onUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(url: string, roomId: string, doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve) => {
      this.ws.once('open', () => this.ws.send(encodeHello(roomId)));
      this.ws.on('message', (data) => {
        const msg = decode(new Uint8Array(data as Buffer));
        switch (msg.type) {
          case MessageType.Welcome:
            this.clientId = msg.clientId;
            this.ws.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
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

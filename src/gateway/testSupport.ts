import { createServer, type Server } from 'node:http';
import pino from 'pino';
import { WebSocket } from 'ws';
import type { Config } from '../config.js';
import { MessageType, PROTOCOL_VERSION, decode, encodeHello, type DecodedMessage } from '../protocol/index.js';
import { GatewayServer, type GatewayServerOptions } from './server.js';

export const testLogger = pino({ level: 'silent' });

export function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    instanceId: 'test-instance',
    redisUrl: undefined,
    demoRoom: 'demo',
    databaseUrl: undefined,
    persistFlushIntervalMs: 20,
    snapshotEveryOps: 500,
    snapshotIntervalMs: 30_000,
    opRetentionVersions: 4,
    maxPendingOps: 2000,
    resumeSecret: 'test-resume-secret-at-least-thirty-two-chars',
    resumeSecretIsEphemeral: false,
    resumeTtlMs: 60_000,
    reconcileIntervalMs: 5000,
    joinSyncTimeoutMs: 500,
    presenceTtlMs: 45_000,
    heartbeatIntervalMs: 10_000,
    heartbeatMaxMissedPongs: 2,
    backpressureThresholdBytes: 1024 * 1024,
    maxInboundMessageBytes: 1024 * 1024,
    logLevel: 'silent',
    ...overrides,
  };
}

export interface Harness {
  httpServer: Server;
  gateway: GatewayServer;
  url: string;
  close(): Promise<void>;
}

export async function startServer(
  config: Config,
  extra: Partial<Pick<GatewayServerOptions, 'persistence'>> = {},
): Promise<Harness> {
  const httpServer = createServer();
  const gateway = new GatewayServer({ server: httpServer, config, logger: testLogger, ...extra });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
  return {
    httpServer,
    gateway,
    url: `ws://127.0.0.1:${address.port}/ws`,
    async close() {
      await gateway.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Queues every decoded message a socket receives from the moment this is
 * created, and hands them out on demand via next(). A plain
 * `ws.once('message', ...)` per awaited message is a race: if two messages
 * arrive back-to-back (often the same tick, e.g. WELCOME immediately
 * followed by a presence snapshot), the second can fire before the test
 * gets around to registering the next listener for it, and is lost.
 * Queuing from the start means arrival order never depends on how fast the
 * test reacts.
 */
export class MessageCollector {
  #queue: DecodedMessage[] = [];
  #waiters: Array<(msg: DecodedMessage) => void> = [];

  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = decode(new Uint8Array(data as Buffer));
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.#queue.push(msg);
      }
    });
  }

  /** Messages received but not yet taken. Unlike racing next() against a
   * timeout, this can't leave a pending waiter behind to swallow a later
   * message, so it is the right way to assert that nothing has arrived. */
  queued(): readonly DecodedMessage[] {
    return this.#queue;
  }

  async next(): Promise<DecodedMessage> {
    const queued = this.#queue.shift();
    if (queued) return queued;
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

export function once(ws: WebSocket, event: 'close' | 'open'): Promise<unknown[]> {
  return new Promise((resolve) => ws.once(event, (...args: unknown[]) => resolve(args)));
}

export async function joinRoom(
  url: string,
  roomId: string,
  resumeToken?: Uint8Array,
): Promise<{
  ws: WebSocket;
  clientId: string;
  resumed: boolean;
  token: Uint8Array;
  messages: MessageCollector;
}> {
  const ws = new WebSocket(url);
  const messages = new MessageCollector(ws);
  await once(ws, 'open');
  ws.send(encodeHello(roomId, PROTOCOL_VERSION, resumeToken));
  const welcome = await messages.next();
  if (welcome.type !== MessageType.Welcome) throw new Error(`expected WELCOME, got type ${welcome.type}`);
  // The server follows WELCOME with the token the client would present to
  // resume this identity; consume it here so tests see the next real message.
  const tokenMessage = await messages.next();
  if (tokenMessage.type !== MessageType.ResumeToken) {
    throw new Error(`expected RESUME_TOKEN, got type ${tokenMessage.type}`);
  }
  return { ws, clientId: welcome.clientId, resumed: welcome.resumed, token: tokenMessage.token, messages };
}

import { createServer, type Server } from 'node:http';
import pino from 'pino';
import { WebSocket } from 'ws';
import type { Config } from '../config.js';
import { MessageType, decode, encodeHello, type DecodedMessage } from '../protocol/index.js';
import { GatewayServer } from './server.js';

export const testLogger = pino({ level: 'silent' });

export function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 0,
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

export async function startServer(config: Config): Promise<Harness> {
  const httpServer = createServer();
  const gateway = new GatewayServer({ server: httpServer, config, logger: testLogger });
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
): Promise<{ ws: WebSocket; clientId: string; messages: MessageCollector }> {
  const ws = new WebSocket(url);
  const messages = new MessageCollector(ws);
  await once(ws, 'open');
  ws.send(encodeHello(roomId));
  const msg = await messages.next();
  if (msg.type !== MessageType.Welcome) throw new Error(`expected WELCOME, got type ${msg.type}`);
  return { ws, clientId: msg.clientId, messages };
}

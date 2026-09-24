import { createServer, type Server } from 'node:http';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Config } from '../config.js';
import {
  CloseCode,
  MessageType,
  decode,
  encodeHello,
  encodeMessage,
  encodePong,
} from '../protocol/index.js';
import { GatewayServer } from './server.js';

const logger = pino({ level: 'silent' });

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 10_000,
    heartbeatMaxMissedPongs: 2,
    backpressureThresholdBytes: 1024 * 1024,
    maxInboundMessageBytes: 65536,
    logLevel: 'silent',
    ...overrides,
  };
}

interface Harness {
  httpServer: Server;
  gateway: GatewayServer;
  url: string;
  close(): Promise<void>;
}

async function startServer(config: Config): Promise<Harness> {
  const httpServer = createServer();
  const gateway = new GatewayServer({ server: httpServer, config, logger });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  return {
    httpServer,
    gateway,
    url,
    async close() {
      await gateway.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function once(ws: WebSocket, event: 'message' | 'close' | 'open'): Promise<unknown[]> {
  return new Promise((resolve) => ws.once(event, (...args: unknown[]) => resolve(args)));
}

async function joinRoom(url: string, roomId: string): Promise<{ ws: WebSocket; clientId: string }> {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  ws.send(encodeHello(roomId));
  const [data] = await once(ws, 'message');
  const msg = decode(new Uint8Array(data as Buffer));
  if (msg.type !== MessageType.Welcome) throw new Error(`expected WELCOME, got type ${msg.type}`);
  return { ws, clientId: msg.clientId };
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('GatewayServer', () => {
  it('terminates a connection that misses too many heartbeats', async () => {
    harness = await startServer(baseConfig({ heartbeatIntervalMs: 50, heartbeatMaxMissedPongs: 2 }));
    const { ws } = await joinRoom(harness.url, 'room-a');
    // Deliberately never reply to PING with a PONG.

    const [code] = await once(ws, 'close');
    expect(code).toBe(CloseCode.HeartbeatTimeout);
  }, 10_000);

  it('stays alive when it keeps replying to PING with PONG', async () => {
    harness = await startServer(baseConfig({ heartbeatIntervalMs: 50, heartbeatMaxMissedPongs: 2 }));
    const { ws } = await joinRoom(harness.url, 'room-a');

    let closed = false;
    ws.once('close', () => (closed = true));
    ws.on('message', (data) => {
      const msg = decode(new Uint8Array(data as Buffer));
      if (msg.type === MessageType.Ping) ws.send(encodePong());
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(closed).toBe(false);
    ws.close();
  }, 10_000);

  it('broadcasts within a room but not to other rooms, and not back to the sender', async () => {
    harness = await startServer(baseConfig());
    const { ws: a } = await joinRoom(harness.url, 'room-1');
    const { ws: b } = await joinRoom(harness.url, 'room-1');
    const { ws: c } = await joinRoom(harness.url, 'room-2');

    const bMessages: unknown[] = [];
    const aMessages: unknown[] = [];
    const cMessages: unknown[] = [];
    b.on('message', (data) => bMessages.push(decode(new Uint8Array(data as Buffer))));
    a.on('message', (data) => aMessages.push(decode(new Uint8Array(data as Buffer))));
    c.on('message', (data) => cMessages.push(decode(new Uint8Array(data as Buffer))));

    const payload = new TextEncoder().encode('hello room-1');
    a.send(encodeMessage(payload));

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(bMessages).toHaveLength(1);
    expect(bMessages[0]).toMatchObject({ type: MessageType.Message });
    expect(Array.from((bMessages[0] as { payload: Uint8Array }).payload)).toEqual(Array.from(payload));

    expect(aMessages).toHaveLength(0);
    expect(cMessages).toHaveLength(0);

    a.close();
    b.close();
    c.close();
  });

  it('rejects a HELLO with an unknown protocol version', async () => {
    harness = await startServer(baseConfig());
    const ws = new WebSocket(harness.url);
    await once(ws, 'open');
    ws.send(encodeHello('room-x', 99));
    const [code] = await once(ws, 'close');
    expect(code).toBe(CloseCode.ProtocolVersionMismatch);
  });

  it('rejects a frame larger than the configured limit', async () => {
    // Payload sized to exceed maxInboundMessageBytes (16) while staying
    // under the gateway's own maxPayload backstop (16 * 4 = 64), so this
    // exercises our explicit size check and its CloseCode.MessageTooLarge
    // rather than `ws`'s generic 1009 from the backstop tripping first.
    harness = await startServer(baseConfig({ maxInboundMessageBytes: 16 }));
    const { ws } = await joinRoom(harness.url, 'room-a');
    ws.send(encodeMessage(new Uint8Array(32)));
    const [code] = await once(ws, 'close');
    expect(code).toBe(CloseCode.MessageTooLarge);
  });

  it('issues server-assigned client IDs, never client-supplied ones', async () => {
    harness = await startServer(baseConfig());
    const { clientId: idA } = await joinRoom(harness.url, 'room-a');
    const { clientId: idB } = await joinRoom(harness.url, 'room-a');
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^[0-9a-f-]{36}$/);
  });
});

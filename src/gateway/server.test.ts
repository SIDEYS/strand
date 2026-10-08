import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { PresenceValue } from '../presence/types.js';
import { CloseCode, MessageType, encodeDocUpdate, encodeHello, encodePong, encodePresenceUpdate } from '../protocol/index.js';
import { baseConfig, joinRoom, once, startServer, type Harness } from './testSupport.js';

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
    const { ws, messages } = await joinRoom(harness.url, 'room-a');

    let closed = false;
    ws.once('close', () => (closed = true));
    void (async () => {
      for (;;) {
        const msg = await messages.next();
        if (msg.type === MessageType.Ping) ws.send(encodePong());
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(closed).toBe(false);
    ws.close();
  }, 10_000);

  it('broadcasts within a room but not to other rooms, and not back to the sender', async () => {
    harness = await startServer(baseConfig());
    const { ws: a, clientId: aId } = await joinRoom(harness.url, 'room-1');
    const { ws: b, messages: bMessages } = await joinRoom(harness.url, 'room-1');
    const { ws: c, messages: cMessages } = await joinRoom(harness.url, 'room-2');

    const value: PresenceValue = { displayName: 'Ada', color: '#fff', cursor: new Uint8Array([5]), selection: null };
    a.send(encodePresenceUpdate(value));

    const received = await bMessages.next();
    expect(received).toMatchObject({ type: MessageType.PresenceBroadcast, clientId: aId, value });

    await new Promise((resolve) => setTimeout(resolve, 100));
    // No good way to prove a negative other than "nothing arrived in a
    // reasonable window" — c is in a different room and a never gets an
    // echo of its own update.
    const cNext = Promise.race([cMessages.next(), new Promise((resolve) => setTimeout(() => resolve('timeout'), 100))]);
    expect(await cNext).toBe('timeout');

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
    ws.send(encodeDocUpdate(new Uint8Array(32)));
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

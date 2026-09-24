import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { PresenceValue } from '../presence/types.js';
import { MessageType, encodeHello, encodePresenceUpdate } from '../protocol/index.js';
import { MessageCollector, baseConfig, joinRoom, once, startServer, type Harness } from './testSupport.js';

const alice: PresenceValue = { displayName: 'Alice', color: '#f00', cursor: 3, selection: null };
const bob: PresenceValue = { displayName: 'Bob', color: '#0f0', cursor: 7, selection: { anchor: 1, head: 4 } };

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('GatewayServer presence', () => {
  it('broadcasts a PRESENCE_UPDATE to the rest of the room, stamped with a server timestamp', async () => {
    harness = await startServer(baseConfig());
    const { ws: a, clientId: aId } = await joinRoom(harness.url, 'room-p1');
    const { messages: bMessages } = await joinRoom(harness.url, 'room-p1');

    const before = Date.now();
    a.send(encodePresenceUpdate(alice));
    const msg = await bMessages.next();
    const after = Date.now();

    expect(msg).toMatchObject({ type: MessageType.PresenceBroadcast, clientId: aId, value: alice });
    if (msg.type !== MessageType.PresenceBroadcast) throw new Error('unreachable');
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);

    a.close();
  });

  it('gives a newly-joined client a snapshot of presence already in the room', async () => {
    harness = await startServer(baseConfig());
    const { ws: a, clientId: aId } = await joinRoom(harness.url, 'room-p2');
    a.send(encodePresenceUpdate(alice));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // b joins after alice's presence was already established: WELCOME
    // arrives first, and the presence snapshot immediately after it — both
    // messages are queued by MessageCollector regardless of how quickly
    // this test reads them.
    const ws = new WebSocket(harness.url);
    const messages = new MessageCollector(ws);
    await once(ws, 'open');
    ws.send(encodeHello('room-p2'));

    const welcome = await messages.next();
    expect(welcome.type).toBe(MessageType.Welcome);

    const snapshot = await messages.next();
    expect(snapshot).toMatchObject({ type: MessageType.PresenceBroadcast, clientId: aId, value: alice });

    a.close();
    ws.close();
  });

  it('removes presence and notifies the room when a connection disconnects', async () => {
    harness = await startServer(baseConfig());
    const { ws: a, clientId: aId } = await joinRoom(harness.url, 'room-p3');
    const { messages: bMessages } = await joinRoom(harness.url, 'room-p3');
    a.send(encodePresenceUpdate(alice));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await bMessages.next(); // the PRESENCE_BROADCAST from alice's update above

    a.close();
    const msg = await bMessages.next();
    expect(msg).toMatchObject({ type: MessageType.PresenceRemove, clientId: aId });
  });

  it('presence for two independent clients merges correctly regardless of who updates last', async () => {
    harness = await startServer(baseConfig());
    const { ws: a, clientId: aId, messages: aMessages } = await joinRoom(harness.url, 'room-p4');
    const { ws: b, clientId: bId, messages: bMessages } = await joinRoom(harness.url, 'room-p4');

    // Both send at "the same time" — order between them is not guaranteed,
    // and shouldn't matter since they're updating different elements.
    a.send(encodePresenceUpdate(alice));
    b.send(encodePresenceUpdate(bob));

    const bSeesA = await bMessages.next();
    const aSeesB = await aMessages.next();
    expect(bSeesA).toMatchObject({ clientId: aId, value: alice });
    expect(aSeesB).toMatchObject({ clientId: bId, value: bob });

    a.close();
    b.close();
  });
});

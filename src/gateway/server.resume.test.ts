import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { PresenceValue } from '../presence/types.js';
import { CloseCode, MessageType, PROTOCOL_VERSION, encodeHello, encodePresenceUpdate } from '../protocol/index.js';
import { signResumeToken, verifyResumeToken } from '../session/resumeToken.js';
import { baseConfig, joinRoom, once, startServer, type Harness } from './testSupport.js';

const config = baseConfig();
const ada: PresenceValue = { displayName: 'Ada', color: '#f0f', cursor: new Uint8Array([3]), selection: null };

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function tokenFor(clientId: string, roomId: string, overrides: { secret?: string; expiresAt?: number } = {}): Uint8Array {
  const now = Date.now();
  return signResumeToken(overrides.secret ?? config.resumeSecret, {
    clientId,
    roomId,
    issuedAt: now - 1000,
    expiresAt: overrides.expiresAt ?? now + 60_000,
  });
}

describe('resume handshake (standalone)', () => {
  it('issues a verifiable token after WELCOME, bound to the client and room', async () => {
    harness = await startServer(config);
    const { clientId, token, resumed } = await joinRoom(harness.url, 'room-a');
    expect(resumed).toBe(false);
    const verdict = verifyResumeToken(config.resumeSecret, token, 'room-a', Date.now());
    expect(verdict.ok && verdict.claims.clientId).toBe(clientId);
  });

  it('restores the same client ID from a valid token, and says so', async () => {
    harness = await startServer(config);
    const first = await joinRoom(harness.url, 'room-a');
    first.ws.close();
    await once(first.ws, 'close');

    const second = await joinRoom(harness.url, 'room-a', first.token);
    expect(second.clientId).toBe(first.clientId);
    expect(second.resumed).toBe(true);
  });

  it('treats an expired token as a new user rather than an error', async () => {
    harness = await startServer(config);
    const stale = tokenFor('someone', 'room-a', { expiresAt: Date.now() - 1 });
    const joined = await joinRoom(harness.url, 'room-a', stale);
    expect(joined.resumed).toBe(false);
    expect(joined.clientId).not.toBe('someone');
  });

  it('treats a token for a different room as a new user', async () => {
    harness = await startServer(config);
    const joined = await joinRoom(harness.url, 'room-b', tokenFor('someone', 'room-a'));
    expect(joined.resumed).toBe(false);
    expect(joined.clientId).not.toBe('someone');
  });

  it('never lets a client choose its ID: a token signed with the wrong secret is ignored', async () => {
    harness = await startServer(config);
    const forged = tokenFor('admin-ish-id', 'room-a', { secret: 'not-the-servers-secret-0000000000000000' });
    const joined = await joinRoom(harness.url, 'room-a', forged);
    expect(joined.resumed).toBe(false);
    expect(joined.clientId).not.toBe('admin-ish-id');
  });

  it('ignores garbage in the token field instead of dropping the connection', async () => {
    harness = await startServer(config);
    const joined = await joinRoom(harness.url, 'room-a', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(joined.resumed).toBe(false);
  });

  it('rejects a v1 client before reading anything it sent', async () => {
    harness = await startServer(config);
    const ws = new WebSocket(harness.url);
    await once(ws, 'open');
    ws.send(encodeHello('room-a', 1));
    const [code] = await once(ws, 'close');
    expect(code).toBe(CloseCode.ProtocolVersionMismatch);
  });

  it('fences the older connection when the same token is presented again, newest wins', async () => {
    harness = await startServer(config);
    const first = await joinRoom(harness.url, 'room-dup');
    const firstClosed = once(first.ws, 'close');

    const second = await joinRoom(harness.url, 'room-dup', first.token);
    const [code] = await firstClosed;

    expect(code).toBe(CloseCode.Superseded);
    expect(second.clientId).toBe(first.clientId);
    expect(second.resumed).toBe(true);
    // The fenced connection's departure must not have evicted its successor.
    expect(harness.gateway.roomSize('room-dup')).toBe(1);
  });

  it('keeps the client\'s presence through a supersede: the person never left', async () => {
    harness = await startServer(config);
    const first = await joinRoom(harness.url, 'room-presence');
    const observer = await joinRoom(harness.url, 'room-presence');
    first.ws.send(encodePresenceUpdate(ada));
    expect((await observer.messages.next()).type).toBe(MessageType.PresenceBroadcast);

    const firstClosed = once(first.ws, 'close');
    const second = await joinRoom(harness.url, 'room-presence', first.token);
    await firstClosed;

    // Bounded observation for a negative: no PresenceRemove for this client.
    const next = await Promise.race([
      observer.messages.next(),
      new Promise<'quiet'>((resolve) => setTimeout(() => resolve('quiet'), 300)),
    ]);
    expect(next).toBe('quiet');

    // And a newcomer still sees the client in the room (the second
    // connection's own snapshot excludes itself, so ask with a third).
    const newcomer = await joinRoom(harness.url, 'room-presence');
    const snapshot = await newcomer.messages.next();
    expect(snapshot).toMatchObject({ type: MessageType.PresenceBroadcast, clientId: second.clientId });
  });

  it('still removes presence when a connection that was not replaced simply goes away', async () => {
    harness = await startServer(config);
    const leaver = await joinRoom(harness.url, 'room-leave');
    const observer = await joinRoom(harness.url, 'room-leave');
    leaver.ws.send(encodePresenceUpdate(ada));
    await observer.messages.next();

    leaver.ws.close();
    const msg = await observer.messages.next();
    expect(msg).toMatchObject({ type: MessageType.PresenceRemove, clientId: leaver.clientId });
  });

  it('re-sends a fresh token before the old one would expire, so a long-lived connection can still resume', async () => {
    harness = await startServer(baseConfig({ resumeTtlMs: 400, heartbeatIntervalMs: 50, heartbeatMaxMissedPongs: 1000 }));
    const { messages, token } = await joinRoom(harness.url, 'room-refresh');
    const original = verifyResumeToken(config.resumeSecret, token, 'room-refresh', Date.now());
    if (!original.ok) throw new Error('initial token should verify');

    let refreshed: Uint8Array | null = null;
    const deadline = Date.now() + 5000;
    while (refreshed === null && Date.now() < deadline) {
      const msg = await Promise.race([messages.next(), new Promise<null>((r) => setTimeout(() => r(null), 100))]);
      if (msg !== null && msg.type === MessageType.ResumeToken) refreshed = msg.token;
    }
    expect(refreshed).not.toBeNull();
    const verdict = verifyResumeToken(config.resumeSecret, refreshed!, 'room-refresh', Date.now());
    expect(verdict.ok && verdict.claims.expiresAt).toBeGreaterThan(original.claims.expiresAt);
  });

  it('is still PROTOCOL_VERSION 3 (guards against an accidental bump or revert)', () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});

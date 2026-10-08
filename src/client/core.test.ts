import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { PresenceValue } from '../presence/types.js';
import {
  CloseCode,
  MessageType,
  PROTOCOL_VERSION,
  decode,
  encodePresenceBroadcast,
  encodePresenceRemove,
} from '../protocol/index.js';
import { CollabClient, type CollabClientOptions } from './core.js';
import { FakeClock, FakeNetwork, FakeServer } from './fakes.js';

const POLICY = { baseMs: 100, capMs: 1600, immediateJitterMs: 50 };
const HEARTBEAT_MS = 1000;
// livenessTimeoutMs(1000) = 2500, checked every 625ms.

function world() {
  const clock = new FakeClock();
  const server = new FakeServer(HEARTBEAT_MS);
  const net = new FakeNetwork(server);
  const make = (overrides: Partial<CollabClientOptions> = {}) =>
    new CollabClient({
      roomId: 'room',
      url: (attempt) => `ws://fake/${attempt}`,
      socketFactory: net.factory,
      scheduler: clock,
      random: () => 0, // deterministic: every delay is the floor of its range
      policy: POLICY,
      ...overrides,
    });
  const connect = (client: CollabClient) => {
    client.start();
    net.openLatest();
  };
  /** Advance time, delivering a server ping at each heartbeat. */
  const run = (ms: number, pingEvery = HEARTBEAT_MS / 2) => {
    for (let elapsed = 0; elapsed < ms; elapsed += pingEvery) {
      clock.advance(Math.min(pingEvery, ms - elapsed));
      server.ping();
    }
  };
  return { clock, server, net, make, connect, run };
}

const kinds = (sent: Uint8Array[]) => sent.map((bytes) => decode(bytes).type);
const textOf = (client: CollabClient) => client.doc.getText('content').toJSON();
const value = (name: string): PresenceValue => ({ displayName: name, color: '#fff', cursor: null, selection: null });

describe('CollabClient handshake and sync', () => {
  it('says HELLO with the current version, then syncs from its state vector once welcomed', () => {
    const { net, make, connect } = world();
    const client = make();
    connect(client);

    const sent = net.latest.sent.map((bytes) => decode(bytes));
    expect(sent[0]).toMatchObject({ type: MessageType.Hello, protocolVersion: PROTOCOL_VERSION, roomId: 'room', resumeToken: null });
    expect(sent[1]!.type).toBe(MessageType.SyncStep1);
    expect(client.getSnapshot().status).toBe('connected');
    expect(client.getSnapshot().clientId).toBe('client-1');
  });

  it('sends nothing but HELLO before it has been welcomed, and counts edits it could not send', () => {
    const { net, make } = world();
    const client = make();
    client.start();
    client.doc.getText('content').insert(0, 'typed too early');
    net.openLatest();

    // HELLO, then (after the welcome) the resync, which carries the edit.
    const types = kinds(net.latest.sent);
    expect(types[0]).toBe(MessageType.Hello);
    expect(client.getSnapshot().unsyncedLocalUpdates).toBe(0); // handed over by the resync
  });

  it('relays edits between two clients through the server', () => {
    const { make, connect, server } = world();
    const a = make();
    const b = make();
    connect(a);
    connect(b);

    a.doc.getText('content').insert(0, 'from a');
    b.doc.getText('content').insert(0, 'from b ');
    expect(textOf(a)).toBe(textOf(b));
    expect(textOf(a)).toContain('from a');
    expect(textOf(a)).toContain('from b');
    expect(Y.encodeStateVector(server.doc)).toEqual(Y.encodeStateVector(a.doc));
  });

  it('answers a heartbeat ping with a pong', () => {
    const { net, make, connect, server } = world();
    const client = make();
    connect(client);
    const before = net.latest.sent.length;
    server.ping();
    expect(kinds(net.latest.sent.slice(before))).toEqual([MessageType.Pong]);
  });

  it('reports a frame it cannot decode instead of dying', () => {
    const { net, make, connect } = world();
    const errors: unknown[] = [];
    const client = make({ onProtocolError: (e) => errors.push(e) });
    connect(client);
    net.latest.deliver(new Uint8Array([0xee, 0xee]));
    expect(errors).toHaveLength(1);
    expect(client.getSnapshot().status).toBe('connected');
  });
});

describe('CollabClient resume and reconnect', () => {
  it('presents its resume token on reconnect and is welcomed back as the same client', () => {
    const { clock, net, make, connect } = world();
    const client = make();
    connect(client);
    const id = client.getSnapshot().clientId;

    net.latest.serverClose(1006);
    expect(client.getSnapshot().status).toBe('reconnecting');
    clock.advance(50);
    net.openLatest();

    const hello = decode(net.latest.sent[0]!);
    expect(hello.type === MessageType.Hello && hello.resumeToken).not.toBeNull();
    expect(client.getSnapshot().clientId).toBe(id);
    expect(client.getSnapshot().resumed).toBe(true);
    expect(client.stats.resumedFlags).toEqual([false, true]);
  });

  it('uses a token from an earlier page load, and reports each new one', () => {
    const { net, make, connect } = world();
    const tokens: Uint8Array[] = [];
    const client = make({
      resumeToken: new TextEncoder().encode('token:client-77'),
      onResumeToken: (t) => tokens.push(t),
    });
    connect(client);
    expect(client.getSnapshot().clientId).toBe('client-77');
    expect(client.getSnapshot().resumed).toBe(true);
    expect(tokens).toHaveLength(1);
    expect(decode(net.latest.sent[0]!)).toMatchObject({ type: MessageType.Hello });
  });

  it('backs off on exactly the schedule the policy specifies, and never earlier', () => {
    const { clock, net, make } = world();
    net.refuse = true;
    const client = make();
    client.start(); // the first attempt fails immediately

    // random() = 0, so each delay is half the ceiling: 50, 100, 200, 400, 800, then capped at 800.
    const expected = [50, 100, 200, 400, 800, 800];
    let attempts = client.stats.connectAttempts;
    expect(attempts).toBe(1);
    for (const delay of expected) {
      clock.advance(delay - 1);
      expect(client.stats.connectAttempts, `before ${delay}ms`).toBe(attempts);
      clock.advance(1);
      attempts += 1;
      expect(client.stats.connectAttempts, `at ${delay}ms`).toBe(attempts);
    }
  });

  it('resets the backoff only after a completed handshake', () => {
    const { clock, net, make, connect } = world();
    const client = make();
    connect(client);
    net.latest.serverClose(1006); // failure 1 -> 50ms
    clock.advance(50);
    net.latest.serverClose(1006); // never reached welcome: failure 2 -> 100ms
    clock.advance(99);
    expect(client.stats.connectAttempts).toBe(2);
    clock.advance(1);
    expect(client.stats.connectAttempts).toBe(3);
    net.openLatest(); // this one completes
    net.latest.serverClose(1006);
    clock.advance(49);
    expect(client.stats.connectAttempts).toBe(3); // back to the 50ms rung
    clock.advance(1);
    expect(client.stats.connectAttempts).toBe(4);
  });

  it('retries almost at once when the server says it is going away', () => {
    const { clock, net, make, connect } = world();
    const client = make({ random: () => 0.5 });
    connect(client);
    net.latest.serverClose(CloseCode.ServerGoingAway);
    clock.advance(24);
    expect(client.stats.connectAttempts).toBe(1);
    clock.advance(1); // immediateJitterMs 50 * 0.5
    expect(client.stats.connectAttempts).toBe(2);
  });

  it('never retries a protocol-version mismatch: no further attempt, ever', () => {
    const { clock, net, make, connect } = world();
    const client = make();
    connect(client);
    net.latest.serverClose(CloseCode.ProtocolVersionMismatch);

    expect(client.getSnapshot().state).toEqual({ status: 'failed', reason: 'version-mismatch' });
    expect(clock.pending).toBe(0);
    clock.advance(60 * 60 * 1000);
    expect(client.stats.connectAttempts).toBe(1);
  });

  it('stops on superseded, and only a deliberate reconnect takes the session back', () => {
    const { clock, net, make, connect } = world();
    const client = make();
    connect(client);
    net.latest.serverClose(CloseCode.Superseded);
    clock.advance(60_000);
    expect(client.getSnapshot().state).toEqual({ status: 'failed', reason: 'superseded' });
    expect(client.stats.connectAttempts).toBe(1);

    client.manualReconnect();
    net.openLatest();
    expect(client.getSnapshot().status).toBe('connected');
    expect(client.stats.connectAttempts).toBe(2);
  });

  it('pauses on browser-offline without retrying, and starts over when the network returns', () => {
    const { clock, net, make, connect } = world();
    const client = make();
    connect(client);
    const first = net.latest;

    client.notifyNetwork(false);
    expect(client.getSnapshot().status).toBe('offline');
    expect(first.closedByClient).toBe(true);
    expect(clock.pending).toBe(0);
    clock.advance(60_000);
    expect(client.stats.connectAttempts).toBe(1);

    client.notifyNetwork(true);
    net.openLatest();
    expect(client.getSnapshot().status).toBe('connected');
    expect(client.stats.connectAttempts).toBe(2);
  });

  it('stop() closes the socket and leaves no timers or retries behind', () => {
    const { clock, net, make, connect } = world();
    const client = make();
    connect(client);
    net.latest.serverClose(1006);
    client.stop();
    clock.advance(60_000);
    expect(client.stats.connectAttempts).toBe(1);
    expect(clock.pending).toBe(0);
  });
});

describe('CollabClient liveness', () => {
  it('stays connected while the server keeps pinging', () => {
    const { net, make, connect, run } = world();
    const client = make();
    connect(client);
    run(30_000);
    expect(client.getSnapshot().status).toBe('connected');
    expect(client.stats.connectAttempts).toBe(1);
    expect(net.latest.closedByClient).toBe(false);
  });

  it('calls a silent connection offline on its own, even though the socket never closes', () => {
    const { clock, net, make, connect, run } = world();
    const client = make();
    connect(client);
    run(3_000);
    const socket = net.latest;

    socket.blackhole = true; // the network dies; the socket does not notice
    clock.advance(2_000); // inside the 2500ms allowance
    expect(client.getSnapshot().status).toBe('connected');

    clock.advance(1_500); // beyond allowance plus one watchdog tick
    expect(client.getSnapshot().status).toBe('offline');
    expect(socket.readyState).toBe(3); // abandoned, not left dangling
    expect(client.stats.closeCodes).toEqual([]); // the socket itself reported nothing
  });

  it('keeps saying offline through failed retries and recovers when a handshake completes', () => {
    const { clock, net, make, connect, run } = world();
    const client = make();
    connect(client);
    run(2_000);

    // The network dies and stays dead: every retry reaches a black hole too.
    net.latest.blackhole = true;
    net.dead = true;
    clock.advance(4_000); // liveness is lost, and the first retry fires inside this window
    expect(client.getSnapshot().status).toBe('offline');
    expect(client.stats.connectAttempts).toBe(2);

    net.openLatest(); // the socket opens, but nothing ever answers the HELLO
    expect(client.getSnapshot().status).toBe('offline');

    // The network comes back while that attempt is still waiting on its
    // handshake. The attempt is hopeless (it is a black hole), so it is only
    // the handshake timeout that frees the client to try again, and the retry
    // after that finds a working network.
    net.dead = false;
    clock.advance(7_900);
    expect(client.getSnapshot().status).toBe('offline'); // still stuck on the hopeless attempt
    clock.advance(400); // handshake timeout, then the next retry
    net.openLatest();
    expect(client.getSnapshot().status).toBe('connected');
    expect(client.getSnapshot().resumed).toBe(true);
  });

  it('gives up on a connect that never completes instead of waiting for the OS', () => {
    const { clock, net, make } = world();
    const client = make();
    client.start();
    expect(client.getSnapshot().status).toBe('connecting');
    clock.advance(7_999);
    expect(client.stats.connectAttempts).toBe(1);
    expect(client.getSnapshot().status).toBe('connecting');
    clock.advance(1);
    expect(client.getSnapshot().status).toBe('offline');
    expect(net.latest.readyState).toBe(3);
  });
});

describe('CollabClient offline editing', () => {
  it('keeps edits made while offline, counts them, and merges them with what happened meanwhile', () => {
    const { clock, net, make, connect, run } = world();
    const a = make();
    const b = make();
    connect(a);
    connect(b);
    a.doc.getText('content').insert(0, 'shared ');
    expect(textOf(b)).toBe('shared ');
    const aSocket = net.sockets[0]!;
    run(2_000);

    aSocket.blackhole = true; // a loses its network
    run(5_000); // b keeps hearing pings; a hears nothing
    expect(a.getSnapshot().status).toBe('offline');
    expect(b.getSnapshot().status).toBe('connected');

    // Both keep typing. a's edits cannot reach anyone.
    a.doc.getText('content').insert(0, 'A1 ');
    a.doc.getText('content').insert(0, 'A2 ');
    b.doc.getText('content').insert(0, 'B1 ');
    expect(a.getSnapshot().unsyncedLocalUpdates).toBe(2);
    expect(textOf(a)).not.toContain('B1');
    expect(textOf(b)).not.toContain('A1');

    // The network returns: a reconnects, resumes, and the resync merges both ways.
    clock.advance(500);
    net.openLatest();
    expect(a.getSnapshot().status).toBe('connected');
    expect(textOf(a)).toBe(textOf(b));
    for (const piece of ['shared', 'A1', 'A2', 'B1']) expect(textOf(a)).toContain(piece);
    expect(a.getSnapshot().unsyncedLocalUpdates).toBe(0);
  });

  it('recovers an edit lost in the gap before the dead socket was noticed, via the state-vector resync', () => {
    const { clock, net, make, connect, run } = world();
    const a = make();
    const b = make();
    connect(a);
    connect(b);
    run(1_000);

    net.sockets[0]!.blackhole = true;
    // Typed while a still believes it is connected: handed to a dead socket.
    a.doc.getText('content').insert(0, 'lost in the gap');
    expect(textOf(b)).toBe('');

    run(5_000);
    clock.advance(500);
    net.openLatest();
    expect(textOf(b)).toBe('lost in the gap');
  });
});

describe('CollabClient presence', () => {
  it('announces its presence on every connect, not just the first', () => {
    const { clock, net, make, connect } = world();
    const client = make();
    connect(client);
    client.setPresence(value('Ada'));

    const announcements = () => net.sockets.map((s) => kinds(s.sent).filter((t) => t === MessageType.PresenceUpdate).length);
    expect(announcements()).toEqual([1]);

    net.latest.serverClose(1006);
    clock.advance(50);
    net.openLatest();
    expect(announcements()).toEqual([1, 1]);
  });

  it('merges peers by the LWW rules: an older update never overrides a newer one', () => {
    const { net, make, connect } = world();
    const client = make();
    connect(client);

    net.latest.deliver(encodePresenceBroadcast('peer', 10, value('new')));
    net.latest.deliver(encodePresenceBroadcast('peer', 5, value('stale')));
    expect(client.getSnapshot().peers).toEqual([{ clientId: 'peer', value: value('new') }]);
  });

  it('keeps a removed peer removed even if a stale add arrives afterwards', () => {
    const { net, make, connect } = world();
    const client = make();
    connect(client);

    net.latest.deliver(encodePresenceBroadcast('peer', 5, value('here')));
    net.latest.deliver(encodePresenceRemove('peer', 9));
    net.latest.deliver(encodePresenceBroadcast('peer', 8, value('late add')));
    expect(client.getSnapshot().peers).toEqual([]);
  });

  it('forgets peers who left while it was disconnected: a reconnect starts from the server\'s snapshot', () => {
    const { clock, net, make, connect, server } = world();
    const client = make();
    const other = make();
    connect(client);
    connect(other);
    other.setPresence(value('Grace'));
    expect(client.getSnapshot().peers.map((p) => p.value.displayName)).toEqual(['Grace']);

    net.sockets[0]!.serverClose(1006); // client drops
    other.stop(); // and meanwhile Grace leaves
    server.presence.clear();
    clock.advance(50);
    net.openLatest();
    expect(client.getSnapshot().peers).toEqual([]);
  });

  it('never lists itself as a peer', () => {
    const { net, make, connect } = world();
    const client = make();
    connect(client);
    net.latest.deliver(encodePresenceBroadcast(client.getSnapshot().clientId, 3, value('me')));
    expect(client.getSnapshot().peers).toEqual([]);
  });
});

describe('CollabClient snapshots', () => {
  it('returns the same object until something changes, and notifies subscribers when it does', () => {
    const { net, make, connect } = world();
    const client = make();
    connect(client);
    let notifications = 0;
    const unsubscribe = client.subscribe(() => (notifications += 1));

    const first = client.getSnapshot();
    expect(client.getSnapshot()).toBe(first);

    net.latest.deliver(encodePresenceBroadcast('peer', 1, value('x')));
    expect(notifications).toBeGreaterThan(0);
    expect(client.getSnapshot()).not.toBe(first);

    unsubscribe();
    const seen = notifications;
    net.latest.deliver(encodePresenceBroadcast('peer', 2, value('y')));
    expect(notifications).toBe(seen);
  });
});

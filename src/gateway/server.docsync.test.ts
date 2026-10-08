import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { MessageType, decode, encodeDocUpdate, encodeHello, encodeSyncStep1 } from '../protocol/index.js';
import { baseConfig, joinRoom, startServer, type Harness } from './testSupport.js';

/** A minimal stand-in for the real Phase 6 client: a Yjs doc wired to a
 * WebSocket using our protocol, sending local updates and applying remote
 * ones. Good enough to prove the sync handshake and convergence work. One
 * persistent 'message' listener (rather than a mix of once()s scattered
 * through the test) so nothing races an event that fires before a listener
 * for it exists. */
class TestClient {
  ws: WebSocket;
  doc = new Y.Doc();
  ready: Promise<void>;
  syncStep2Log: Uint8Array[] = [];

  constructor(url: string, roomId: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve) => {
      this.ws.once('open', () => this.ws.send(encodeHello(roomId)));
      this.ws.on('message', (data) => {
        const msg = decode(new Uint8Array(data as Buffer));
        if (msg.type === MessageType.Welcome) {
          this.ws.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
        } else if (msg.type === MessageType.SyncStep2) {
          this.syncStep2Log.push(msg.update);
          Y.applyUpdate(this.doc, msg.update, 'remote');
          resolve();
        } else if (msg.type === MessageType.DocUpdate) {
          Y.applyUpdate(this.doc, msg.update, 'remote');
        }
      });
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return; // don't echo remote updates back out
      this.ws.send(encodeDocUpdate(update));
    });
  }

  text(): string {
    return this.doc.getText('content').toJSON();
  }

  close(): void {
    this.ws.close();
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('GatewayServer Yjs document sync', () => {
  it('SYNC_STEP2 carries only the missing delta, not the whole document, once the client is caught up', async () => {
    harness = await startServer(baseConfig());
    const a = new TestClient(harness.url, 'room-sync');
    await a.ready;
    // A substantial insert so a full-document sync is clearly larger than
    // an empty diff — not just larger by a few bytes of protocol overhead.
    a.doc.getText('content').insert(0, 'hello world '.repeat(200));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const b = new TestClient(harness.url, 'room-sync');
    await b.ready; // b's initial SYNC_STEP1 (empty state vector) → full-doc SYNC_STEP2
    expect(b.text()).toBe(a.text());
    const freshSyncSize = Y.encodeStateAsUpdate(new Y.Doc()).length + a.text().length;

    // b is now fully caught up. Asking again with its *current* (non-empty,
    // real) state vector should come back with a near-empty diff, because
    // there is nothing new for the server to send.
    b.ws.send(encodeSyncStep1(Y.encodeStateVector(b.doc)));
    await waitUntil(() => b.syncStep2Log.length >= 2);
    const redundantDiff = b.syncStep2Log[1]!;

    expect(redundantDiff.length).toBeLessThan(50);
    expect(redundantDiff.length).toBeLessThan(freshSyncSize);

    a.close();
    b.close();
  });

  it('follows SYNC_STEP2 with its own state vector, so the client can send only what the server lacks', async () => {
    harness = await startServer(baseConfig());
    const author = new TestClient(harness.url, 'room-sv');
    await author.ready;
    author.doc.getText('content').insert(0, 'on the server');
    await new Promise((resolve) => setTimeout(resolve, 150));

    // A client that kept its doc across a disconnect and has one local edit
    // the server has never seen.
    const local = new Y.Doc();
    const { ws, messages } = await joinRoom(harness.url, 'room-sv');
    ws.send(encodeSyncStep1(Y.encodeStateVector(local)));
    const step2 = await messages.next();
    const step1 = await messages.next();
    expect(step2.type).toBe(MessageType.SyncStep2);
    expect(step1.type).toBe(MessageType.SyncStep1);
    if (step2.type !== MessageType.SyncStep2 || step1.type !== MessageType.SyncStep1) throw new Error('unreachable');

    Y.applyUpdate(local, step2.update, 'remote');
    local.getText('content').insert(0, 'offline edit ');
    const missing = Y.encodeStateAsUpdate(local, step1.stateVector);

    // The diff against the server's vector is the offline edit alone, far
    // smaller than the whole document.
    expect(missing.length).toBeLessThan(Y.encodeStateAsUpdate(local).length);
    ws.send(encodeDocUpdate(missing));
    await waitUntil(() => author.text().includes('offline edit '), 3000);
    expect(author.text()).toContain('on the server');

    author.close();
    ws.close();
  });

  it('withholds document updates from a member until its initial sync, which already covers them', async () => {
    harness = await startServer(baseConfig());
    const author = new TestClient(harness.url, 'room-gate');
    await author.ready;

    // A newcomer that has joined but not yet asked to sync.
    const { ws, messages } = await joinRoom(harness.url, 'room-gate');
    author.doc.getText('content').insert(0, 'typed before the newcomer synced');
    // Bounded observation window for a negative.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(messages.queued(), 'no DOC_UPDATE before the newcomer has synced').toHaveLength(0);

    // Its sync then delivers that content exactly once, as SYNC_STEP2.
    ws.send(encodeSyncStep1(Y.encodeStateVector(new Y.Doc())));
    const step2 = await messages.next();
    expect(step2.type).toBe(MessageType.SyncStep2);
    if (step2.type !== MessageType.SyncStep2) throw new Error('unreachable');
    const local = new Y.Doc();
    Y.applyUpdate(local, step2.update, 'remote');
    expect(local.getText('content').toJSON()).toBe('typed before the newcomer synced');

    // And once synced it receives later updates normally.
    await messages.next(); // the server's SyncStep1
    author.doc.getText('content').insert(0, '!');
    expect((await messages.next()).type).toBe(MessageType.DocUpdate);

    author.close();
    ws.close();
  });

  it('two clients converge to identical document state after concurrent edits', async () => {
    harness = await startServer(baseConfig());
    const a = new TestClient(harness.url, 'room-concurrent');
    const b = new TestClient(harness.url, 'room-concurrent');
    await Promise.all([a.ready, b.ready]);

    // Concurrent, non-overlapping inserts from both sides at the same time.
    a.doc.getText('content').insert(0, 'Hello from A. ');
    b.doc.getText('content').insert(0, 'Hello from B. ');

    await waitUntil(() => a.text() === b.text() && a.text().length > 0);

    expect(a.text()).toContain('Hello from A.');
    expect(a.text()).toContain('Hello from B.');

    a.close();
    b.close();
  });
});

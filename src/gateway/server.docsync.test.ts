import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { MessageType, decode, encodeDocUpdate, encodeHello, encodeSyncStep1 } from '../protocol/index.js';
import { baseConfig, startServer, type Harness } from './testSupport.js';

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

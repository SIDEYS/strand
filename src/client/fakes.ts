import * as Y from 'yjs';
import {
  MessageType,
  decode,
  encodePresenceBroadcast,
  encodePresenceRemove,
  encodePing,
  encodeResumeToken,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeDocUpdate,
  encodeWelcome,
} from '../protocol/index.js';
import type { PresenceValue } from '../presence/types.js';
import type { ClientSocket, Scheduler } from './types.js';

/**
 * Deterministic stand-ins for the environment the client core is given, so
 * its tests run the real reconnect, backoff, and liveness code with no
 * sockets and no waiting.
 */

/** A clock that only moves when told to. `advance` runs every timer that
 * falls due, in order, including ones scheduled by the callbacks it runs. */
export class FakeClock implements Scheduler {
  #now = 0;
  #nextId = 1;
  #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Number of timers waiting to fire. */
  get pending(): number {
    return this.#timers.size;
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = this.#timers.get(nextId)!;
      this.#timers.delete(nextId);
      this.#now = Math.max(this.#now, timer.at);
      timer.callback();
    }
    this.#now = target;
  }
}

export class FakeSocket implements ClientSocket {
  binaryType = 'blob';
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Everything the client sent. */
  readonly sent: Uint8Array[] = [];
  closedByClient = false;
  /** Set by the fake server to receive what the client sends. */
  onClientSend: ((bytes: Uint8Array) => void) | null = null;
  /** Set by the fake server to learn the connection ended. */
  onEnded: (() => void) | null = null;
  /** True once the network is "dead": frames vanish in both directions but
   * the socket stays open, as a real one can for a long time. */
  blackhole = false;

  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
    if (!this.blackhole) this.onClientSend?.(data);
  }

  close(code = 1000): void {
    this.closedByClient = true;
    this.readyState = 3;
    // A real close handshake would call back; the client detaches handlers
    // before closing sockets it has abandoned, so there is nothing to fire.
    void code;
    this.onEnded?.();
  }

  terminate(): void {
    this.close(1006);
  }

  // ---- driven by the test or the fake server -----------------------------------

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(bytes: Uint8Array): void {
    if (this.blackhole || this.readyState !== 1) return;
    this.onmessage?.({ data: bytes.slice().buffer });
  }

  /** The server (or network) closes the connection. */
  serverClose(code: number): void {
    this.readyState = 3;
    this.onEnded?.();
    this.onclose?.({ code });
  }
}

/**
 * A small server for a client to talk to: it speaks the real wire protocol
 * over fake sockets, keeps a real Y.Doc per instance, answers the sync
 * exchange, relays updates and presence, and pings on demand. Tokens are
 * opaque `token:<clientId>` bytes (the client treats them as opaque).
 */
export class FakeServer {
  readonly doc = new Y.Doc();
  readonly connections: Array<{ socket: FakeSocket; clientId: string }> = [];
  readonly presence = new Map<string, { timestamp: number; value: PresenceValue }>();
  #clientCounter = 0;
  #clock = 1;
  readonly heartbeatIntervalMs: number;

  constructor(heartbeatIntervalMs = 1000) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    // Updates from any client are relayed to the others by the handler below.
  }

  /** Wire up a socket the client just created. */
  accept(socket: FakeSocket): void {
    const connection = { socket, clientId: '' };
    socket.onClientSend = (bytes) => this.#onFrame(connection, bytes);
    socket.onEnded = () => this.disconnect(socket);
  }

  /** Fire one heartbeat ping at every connection. */
  ping(): void {
    for (const { socket } of this.connections) socket.deliver(encodePing());
  }

  #onFrame(connection: { socket: FakeSocket; clientId: string }, bytes: Uint8Array): void {
    const message = decode(bytes);
    switch (message.type) {
      case MessageType.Hello: {
        const token = message.resumeToken ? new TextDecoder().decode(message.resumeToken) : '';
        const resumed = token.startsWith('token:');
        connection.clientId = resumed ? token.slice('token:'.length) : `client-${++this.#clientCounter}`;
        this.connections.push(connection);
        connection.socket.deliver(encodeWelcome(connection.clientId, resumed, this.heartbeatIntervalMs));
        connection.socket.deliver(encodeResumeToken(new TextEncoder().encode(`token:${connection.clientId}`)));
        for (const [clientId, entry] of this.presence) {
          if (clientId !== connection.clientId) {
            connection.socket.deliver(encodePresenceBroadcast(clientId, entry.timestamp, entry.value));
          }
        }
        return;
      }
      case MessageType.SyncStep1:
        connection.socket.deliver(encodeSyncStep2(Y.encodeStateAsUpdate(this.doc, message.stateVector)));
        connection.socket.deliver(encodeSyncStep1(Y.encodeStateVector(this.doc)));
        return;
      case MessageType.DocUpdate:
        Y.applyUpdate(this.doc, message.update, connection);
        for (const other of this.connections) {
          if (other !== connection) other.socket.deliver(encodeDocUpdate(message.update));
        }
        return;
      case MessageType.PresenceUpdate: {
        const timestamp = this.#clock++;
        this.presence.set(connection.clientId, { timestamp, value: message.value });
        for (const other of this.connections) {
          if (other !== connection) {
            other.socket.deliver(encodePresenceBroadcast(connection.clientId, timestamp, message.value));
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /** Called when a client's socket closes, as the real gateway would. */
  disconnect(socket: FakeSocket): void {
    const index = this.connections.findIndex((c) => c.socket === socket);
    if (index < 0) return;
    const [gone] = this.connections.splice(index, 1);
    if (this.presence.delete(gone!.clientId)) {
      const timestamp = this.#clock++;
      for (const other of this.connections) other.socket.deliver(encodePresenceRemove(gone!.clientId, timestamp));
    }
  }
}

/** Hands out FakeSockets and records them, optionally attaching a FakeServer
 * so a connect actually completes a handshake. */
export class FakeNetwork {
  readonly sockets: FakeSocket[] = [];
  readonly urls: string[] = [];
  server: FakeServer | null;
  /** While true, new sockets open but are black holes. */
  dead = false;
  /** While true, the factory throws, like a refused connection. */
  refuse = false;

  constructor(server: FakeServer | null = null) {
    this.server = server;
  }

  factory = (url: string): FakeSocket => {
    if (this.refuse) throw new Error('connection refused');
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    this.urls.push(url);
    if (this.dead) socket.blackhole = true;
    this.server?.accept(socket);
    return socket;
  };

  /** Complete the TCP/WebSocket open for the most recent socket. */
  openLatest(): FakeSocket {
    const socket = this.sockets[this.sockets.length - 1]!;
    socket.open();
    return socket;
  }

  get latest(): FakeSocket {
    return this.sockets[this.sockets.length - 1]!;
  }
}

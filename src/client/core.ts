import * as Y from 'yjs';
import { LwwSet } from '../presence/LwwSet.js';
import type { PresenceValue } from '../presence/types.js';
import {
  MessageType,
  PROTOCOL_VERSION,
  decode,
  encodeDocUpdate,
  encodeHello,
  encodePong,
  encodePresenceUpdate,
  encodeSyncStep1,
} from '../protocol/index.js';
import {
  DEFAULT_RECONNECT_POLICY,
  displayStatus,
  isLive,
  livenessTimeoutMs,
  step,
  type ConnectionEvent,
  type ConnectionState,
  type DisplayStatus,
  type ReconnectPolicy,
} from '../protocol/reconnect.js';
import type { ClientSocket, Scheduler, SocketFactory } from './types.js';

const SOCKET_OPEN = 1;
/** A Yjs update with no structs and an empty delete set is two bytes. */
const EMPTY_UPDATE_BYTES = 2;

export interface Peer {
  clientId: string;
  value: PresenceValue;
}

/** Everything a UI needs, as an immutable value. A new object is produced on
 * every change and the same object is returned until then, which is the
 * contract React's useSyncExternalStore requires. */
export interface ClientSnapshot {
  state: ConnectionState;
  status: DisplayStatus;
  clientId: string;
  resumed: boolean;
  /** True once this connection has applied the server's reply to our state
   * vector, i.e. the document on screen reflects the room. False between
   * connecting and that, and again after any reconnect. */
  synced: boolean;
  peers: readonly Peer[];
  /** Local edits that have not yet been handed to a server: made while
   * disconnected, and cleared once the resync after reconnecting has sent
   * them. */
  unsyncedLocalUpdates: number;
  lastHeardAt: number;
}

export interface CollabClientOptions {
  roomId: string;
  /** Called once per connection attempt, so a load balancer with no
   * stickiness can hand back a different instance each time. */
  url: (attempt: number) => string;
  socketFactory: SocketFactory;
  scheduler: Scheduler;
  random: () => number;
  doc?: Y.Doc;
  policy?: ReconnectPolicy;
  /** Only tests send anything other than the current version. */
  protocolVersion?: number;
  /** A token from an earlier page load, so a refresh keeps its identity. */
  resumeToken?: Uint8Array | null;
  onResumeToken?: (token: Uint8Array) => void;
  /** A frame from the server that failed to decode. */
  onProtocolError?: (error: unknown) => void;
  /** How long a socket may take to complete the handshake before the network
   * is presumed down. Default 8000. */
  handshakeTimeoutMs?: number;
}

/**
 * The client side of the protocol: handshake, resume, sync, reconnect, and
 * message dispatch, with no knowledge of where it is running.
 *
 * It owns no DOM, no React, and no environment. A socket factory, a
 * scheduler, and a source of randomness are all passed in, so the browser
 * hands it the native WebSocket and window timers, integration tests hand it
 * `ws` and the system clock, and unit tests hand it fakes and a clock they
 * advance by hand. The same code runs in all three, which is the point: a
 * test of a parallel implementation says nothing about the one that ships.
 */
export class CollabClient {
  readonly doc: Y.Doc;
  readonly stats = {
    connectAttempts: 0,
    resumedFlags: [] as boolean[],
    closeCodes: [] as number[],
    /** Bytes on the current connection, handshake onward. */
    bytesSent: 0,
    bytesReceived: 0,
  };

  #options: CollabClientOptions;
  #policy: ReconnectPolicy;
  #scheduler: Scheduler;
  #state: ConnectionState = { status: 'idle' };
  #socket: ClientSocket | null = null;
  #retryTimer: unknown;
  #watchdogTimer: unknown;
  #handshakeTimer: unknown;
  #token: Uint8Array | null;
  #clientId = '';
  #resumed = false;
  #synced = false;
  #heartbeatIntervalMs = 0;
  #lastHeardAt = 0;
  #presence = new LwwSet<PresenceValue>();
  #localPresence: PresenceValue | null = null;
  #unsynced = 0;
  #stopped = false;
  #listeners = new Set<() => void>();
  #snapshot: ClientSnapshot;
  #onDocUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(options: CollabClientOptions) {
    this.#options = options;
    this.#scheduler = options.scheduler;
    this.#policy = options.policy ?? DEFAULT_RECONNECT_POLICY;
    this.#token = options.resumeToken ?? null;
    this.doc = options.doc ?? new Y.Doc();
    this.#snapshot = this.#buildSnapshot();

    // `this` is the origin of everything we apply from the server, so this
    // handler can tell a local edit from a replayed remote one without
    // consulting any other state.
    this.#onDocUpdate = (update, origin) => {
      if (origin === this) return;
      if (!this.#send(encodeDocUpdate(update))) {
        this.#unsynced += 1;
        this.#notify();
      }
    };
    this.doc.on('update', this.#onDocUpdate);
  }

  // ---- public surface ------------------------------------------------------

  start(): void {
    this.#dispatch({ type: 'start' });
    this.#notify();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    this.#dropSocket(1000);
    this.doc.off('update', this.#onDocUpdate);
    this.#notify();
  }

  /** This client's own presence (name, colour, caret). Re-announced on every
   * connect, since presence is soft state that does not always survive a
   * gap. */
  setPresence(value: PresenceValue): void {
    this.#localPresence = value;
    if (this.#state.status === 'connected') this.#send(encodePresenceUpdate(value));
  }

  /** The browser's online/offline events. Offline pauses everything; coming
   * back starts over rather than continuing a backoff earned while the
   * network was down. */
  notifyNetwork(online: boolean): void {
    this.#dispatch({ type: 'network', online });
    if (!online) {
      this.#clearTimers();
      this.#dropSocket(1000);
    }
    this.#notify();
  }

  /** For a session that stopped on its own (superseded) or a pause. */
  manualReconnect(): void {
    this.#dispatch({ type: 'manual-reconnect' });
    this.#notify();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): ClientSnapshot {
    return this.#snapshot;
  }

  /** The most recent resume token, for diagnostics and tests. */
  get token(): Uint8Array | null {
    return this.#token;
  }

  // ---- state machine -------------------------------------------------------

  #dispatch(event: ConnectionEvent): void {
    if (this.#stopped) return;
    const { state, effect } = step(this.#state, event, this.#options.random, this.#policy);
    this.#state = state;
    switch (effect.kind) {
      case 'connect':
        this.#clearRetry();
        this.#open();
        break;
      case 'schedule-retry':
        this.#clearRetry();
        this.#retryTimer = this.#scheduler.setTimeout(() => {
          this.#retryTimer = undefined;
          this.#dispatch({ type: 'retry-due' });
          this.#notify();
        }, effect.delayMs);
        break;
      case 'cancel-retry':
        this.#clearRetry();
        break;
      case 'none':
        break;
    }
  }

  // ---- connection ------------------------------------------------------------

  #open(): void {
    this.stats.connectAttempts += 1;
    this.stats.bytesSent = 0;
    this.stats.bytesReceived = 0;
    this.#lastHeardAt = this.#scheduler.now();

    let socket: ClientSocket;
    try {
      socket = this.#options.socketFactory(this.#options.url(this.stats.connectAttempts));
    } catch {
      this.#dispatch({ type: 'closed', code: 1006 });
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    socket.onopen = () => {
      if (socket !== this.#socket) return;
      const hello = encodeHello(
        this.#options.roomId,
        this.#options.protocolVersion ?? PROTOCOL_VERSION,
        this.#token ?? undefined,
      );
      this.stats.bytesSent += hello.length;
      socket.send(hello);
    };
    socket.onmessage = (event) => {
      if (socket !== this.#socket) return;
      this.#onMessage(event.data);
    };
    socket.onclose = (event) => {
      if (socket !== this.#socket) return; // one we already abandoned
      this.#socket = null;
      this.#clearWatchdogs();
      this.stats.closeCodes.push(event.code);
      this.#dispatch({ type: 'closed', code: event.code });
      this.#notify();
    };
    socket.onerror = () => undefined; // always followed by a close event

    // A connect that never completes (the network is down but the OS has not
    // given up) is as useless as a silent one; don't wait for the OS.
    this.#handshakeTimer = this.#scheduler.setTimeout(() => {
      this.#handshakeTimer = undefined;
      if (socket !== this.#socket || this.#state.status !== 'connecting') return;
      this.#abandonAsSilent();
    }, this.#options.handshakeTimeoutMs ?? 8000);
  }

  #onMessage(data: unknown): void {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
    this.stats.bytesReceived += bytes.length;
    this.#lastHeardAt = this.#scheduler.now();

    let message;
    try {
      message = decode(bytes);
    } catch (error) {
      this.#options.onProtocolError?.(error);
      return;
    }

    switch (message.type) {
      case MessageType.Welcome:
        this.#clientId = message.clientId;
        this.#resumed = message.resumed;
        this.#heartbeatIntervalMs = message.heartbeatIntervalMs;
        this.#synced = false;
        this.stats.resumedFlags.push(message.resumed);
        this.#clearHandshakeTimer();
        // The server's snapshot of who is here follows the welcome and says
        // nothing about who left while we were away, so start from empty.
        this.#presence = new LwwSet<PresenceValue>();
        this.#dispatch({ type: 'welcome' });
        this.#armWatchdog();
        this.#send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
        if (this.#localPresence) this.#send(encodePresenceUpdate(this.#localPresence));
        break;

      case MessageType.ResumeToken:
        this.#token = message.token.slice();
        this.#options.onResumeToken?.(this.#token);
        break;

      case MessageType.SyncStep2:
        Y.applyUpdate(this.doc, message.update, this);
        this.#synced = true;
        break;

      case MessageType.DocUpdate:
        Y.applyUpdate(this.doc, message.update, this);
        break;

      case MessageType.SyncStep1: {
        // The server's state vector: send back only what it lacks. This is
        // the moment offline edits are handed over.
        const missing = Y.encodeStateAsUpdate(this.doc, message.stateVector);
        if (missing.length > EMPTY_UPDATE_BYTES) this.#send(encodeDocUpdate(missing));
        this.#unsynced = 0;
        break;
      }

      case MessageType.Ping:
        this.#send(encodePong());
        break;

      case MessageType.PresenceBroadcast:
        this.#presence.add(message.clientId, message.value, message.timestamp, message.clientId);
        break;

      case MessageType.PresenceRemove:
        this.#presence.remove(message.clientId, message.timestamp, message.clientId);
        break;

      default:
        break;
    }
    this.#notify();
  }

  /** Sends only on an established connection. False means the bytes were not
   * sent, and the caller decides whether that matters (a local edit is
   * recovered by the resync that follows reconnecting). */
  #send(bytes: Uint8Array): boolean {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN || this.#state.status !== 'connected') return false;
    this.stats.bytesSent += bytes.length;
    socket.send(bytes);
    return true;
  }

  // ---- liveness ----------------------------------------------------------------

  #armWatchdog(): void {
    this.#clearWatchdog();
    if (this.#heartbeatIntervalMs <= 0) return;
    const timeout = livenessTimeoutMs(this.#heartbeatIntervalMs);
    this.#watchdogTimer = this.#scheduler.setTimeout(() => {
      this.#watchdogTimer = undefined;
      if (this.#state.status !== 'connected') return;
      if (isLive(this.#scheduler.now(), this.#lastHeardAt, timeout)) {
        this.#armWatchdog();
        return;
      }
      this.#abandonAsSilent();
    }, Math.max(1, Math.floor(timeout / 4)));
  }

  /** The connection is open but useless. Don't wait for the socket to find
   * out: abandon it, retry with backoff, and say "offline" meanwhile. */
  #abandonAsSilent(): void {
    this.#dropSocket(4000);
    this.#dispatch({ type: 'liveness-lost' });
    this.#notify();
  }

  // ---- plumbing -------------------------------------------------------------------

  /** Detaches and closes the current socket without reporting it as a
   * server-side close. */
  #dropSocket(code: number): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#clearWatchdogs();
    if (socket === null) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      if (socket.terminate) socket.terminate();
      else socket.close(code);
    } catch {
      // Already gone.
    }
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) this.#scheduler.clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  #clearWatchdog(): void {
    if (this.#watchdogTimer !== undefined) this.#scheduler.clearTimeout(this.#watchdogTimer);
    this.#watchdogTimer = undefined;
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer !== undefined) this.#scheduler.clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
  }

  #clearWatchdogs(): void {
    this.#clearWatchdog();
    this.#clearHandshakeTimer();
  }

  #clearTimers(): void {
    this.#clearRetry();
    this.#clearWatchdogs();
  }

  #notify(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of [...this.#listeners]) listener();
  }

  #buildSnapshot(): ClientSnapshot {
    return {
      state: this.#state,
      status: displayStatus(this.#state),
      clientId: this.#clientId,
      resumed: this.#resumed,
      synced: this.#synced && this.#state.status === 'connected',
      peers: this.#presence
        .entries()
        .filter((entry) => entry.elementId !== this.#clientId)
        .map((entry) => ({ clientId: entry.elementId, value: entry.value })),
      unsyncedLocalUpdates: this.#unsynced,
      lastHeardAt: this.#lastHeardAt,
    };
  }
}

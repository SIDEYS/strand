import type { WebSocket } from 'ws';
import type { Logger } from 'pino';
import type { RoomMember } from '../room/RoomManager.js';
import { CloseCode } from '../protocol/index.js';

export interface ConnectionOptions {
  socket: WebSocket;
  clientId: string;
  backpressureThresholdBytes: number;
  logger: Logger;
}

/** How long to wait for a peer to complete the close handshake after we
 * send a close frame, before we give up and terminate the raw socket. This
 * matters most for exactly the connections we're disconnecting on purpose
 * (backpressured or heartbeat-dead) — those are the ones least likely to
 * ever ack a graceful close. */
const FORCE_CLOSE_GRACE_MS = 2000;

/**
 * Wraps a single `ws` socket. Owns the two things every connection needs
 * regardless of what's flowing over it: outbound backpressure protection
 * and heartbeat bookkeeping. Message *meaning* (HELLO/room routing/etc.)
 * stays in server.ts — this class doesn't know what a room is.
 */
export class Connection implements RoomMember {
  readonly clientId: string;
  roomId: string | null = null;
  /** Consecutive heartbeat ticks this connection has failed to PONG. Reset
   * to 0 whenever a PONG arrives; the gateway's heartbeat loop terminates
   * the connection once this reaches the configured max. */
  missedPongs = 0;
  /** Set once the gateway has removed this connection from its room, so
   * the explicit departure in shutdown and the socket's later close event
   * don't both publish a presence removal. */
  departed = false;

  #socket: WebSocket;
  #backpressureThresholdBytes: number;
  #logger: Logger;
  #forceCloseTimer: NodeJS.Timeout | undefined;

  constructor(options: ConnectionOptions) {
    this.#socket = options.socket;
    this.clientId = options.clientId;
    this.#backpressureThresholdBytes = options.backpressureThresholdBytes;
    this.#logger = options.logger;
    this.#socket.once('close', () => {
      if (this.#forceCloseTimer) clearTimeout(this.#forceCloseTimer);
    });
  }

  /** True if the client isn't draining its socket fast enough to accept
   * more data right now. Exposed mainly so tests can assert on it directly
   * against a fake socket, without needing a real stalled peer. */
  isBackpressured(): boolean {
    return this.#socket.bufferedAmount > this.#backpressureThresholdBytes;
  }

  /** Sends `bytes`, unless the connection is already backpressured — in
   * which case it disconnects instead of adding to an unbounded queue. One
   * slow client must never be allowed to hold a growing buffer against the
   * server; better to drop that client than let it degrade the room. */
  send(bytes: Uint8Array): void {
    if (this.#socket.readyState !== this.#socket.OPEN) return;
    if (this.isBackpressured()) {
      this.#logger.warn(
        { clientId: this.clientId, bufferedAmount: this.#socket.bufferedAmount },
        'backpressure threshold exceeded, disconnecting',
      );
      this.disconnect(CloseCode.BackpressureDisconnect, 'backpressure threshold exceeded');
      return;
    }
    this.#socket.send(bytes, (err) => {
      if (err) this.#logger.warn({ err, clientId: this.clientId }, 'send failed');
    });
  }

  /** Graceful close with an application close code, falling back to an
   * abrupt terminate() if the peer never completes the close handshake
   * (expected for the disconnect reasons we use this for: the peer is
   * either not there, or not reading fast enough to ack anything). */
  disconnect(code: number, reason: string): void {
    if (this.#socket.readyState === this.#socket.CLOSED || this.#socket.readyState === this.#socket.CLOSING) {
      return;
    }
    try {
      this.#socket.close(code, reason);
    } catch (err) {
      this.#logger.warn({ err, clientId: this.clientId }, 'close() threw, terminating instead');
      this.#socket.terminate();
      return;
    }
    this.#forceCloseTimer = setTimeout(() => {
      if (this.#socket.readyState !== this.#socket.CLOSED) this.#socket.terminate();
    }, FORCE_CLOSE_GRACE_MS);
  }

  terminate(): void {
    this.#socket.terminate();
  }
}

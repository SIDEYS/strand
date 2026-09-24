import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from 'pino';
import * as Y from 'yjs';
import type { Config } from '../config.js';
import type { PresenceValue } from '../presence/types.js';
import { RoomManager } from '../room/RoomManager.js';
import type { Room } from '../room/Room.js';
import { Connection } from './connection.js';
import {
  CloseCode,
  MessageType,
  PROTOCOL_VERSION,
  ProtocolDecodeError,
  decode,
  encodePing,
  encodePresenceBroadcast,
  encodePresenceRemove,
  encodeSyncStep2,
  encodeDocUpdate,
  encodeWelcome,
  type DecodedMessage,
} from '../protocol/index.js';

export interface GatewayServerOptions {
  server: HttpServer;
  config: Config;
  logger: Logger;
}

/**
 * Owns the WebSocket upgrade path, the HELLO handshake, message dispatch,
 * and the room-broadcast wiring for a single instance. Cross-instance
 * fan-out (Phase 3) sits behind RoomManager, not here — this class only
 * ever needs to know about connections local to this process.
 */
export class GatewayServer {
  #wss: WebSocketServer;
  #rooms = new RoomManager();
  #connections = new Set<Connection>();
  #config: Config;
  #logger: Logger;
  #heartbeatTimer: NodeJS.Timeout;

  constructor(options: GatewayServerOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#wss = new WebSocketServer({
      server: options.server,
      path: '/ws',
      // A generous backstop above our own maxInboundMessageBytes check: our
      // explicit size check in #onMessage is what produces the clean
      // CloseCode.MessageTooLarge close; this just bounds worst-case memory
      // if that check is ever bypassed, e.g. by a bug.
      maxPayload: options.config.maxInboundMessageBytes * 4,
    });
    this.#wss.on('connection', (socket) => this.#onConnection(socket));
    this.#heartbeatTimer = setInterval(() => this.#tickHeartbeat(), this.#config.heartbeatIntervalMs);
  }

  roomSize(roomId: string): number {
    return this.#rooms.roomSize(roomId);
  }

  connectionCount(): number {
    return this.#connections.size;
  }

  #onConnection(socket: WebSocket): void {
    let connection: Connection | null = null;

    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        socket.close(CloseCode.BadMessage, 'text frames are not supported');
        return;
      }
      const bytes = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data);

      if (bytes.length > this.#config.maxInboundMessageBytes) {
        socket.close(CloseCode.MessageTooLarge, 'message exceeds size limit');
        return;
      }

      let decoded;
      try {
        decoded = decode(bytes);
      } catch (err) {
        const reason = err instanceof ProtocolDecodeError ? err.message : 'malformed message';
        socket.close(CloseCode.BadMessage, reason);
        return;
      }

      if (!connection) {
        connection = this.#handleHandshake(socket, decoded);
        return;
      }

      this.#handleMessage(connection, decoded);
    });

    socket.on('close', () => {
      if (!connection) return;
      this.#connections.delete(connection);
      this.#handleDeparture(connection);
    });

    socket.on('error', (err) => {
      this.#logger.warn({ err }, 'socket error');
    });
  }

  #handleHandshake(socket: WebSocket, decoded: DecodedMessage): Connection | null {
    if (decoded.type !== MessageType.Hello) {
      socket.close(CloseCode.BadMessage, 'expected HELLO as first message');
      return null;
    }
    if (decoded.protocolVersion !== PROTOCOL_VERSION || decoded.roomId === null) {
      socket.close(CloseCode.ProtocolVersionMismatch, `server speaks protocol version ${PROTOCOL_VERSION}`);
      return null;
    }
    if (decoded.roomId.length === 0) {
      socket.close(CloseCode.BadMessage, 'roomId must not be empty');
      return null;
    }

    // Client ID is always server-issued, never taken from the client. If a
    // client could assert its own ID, two tabs could claim the same
    // identity and presence would become incoherent. Phase 4's resume
    // token is the sanctioned way for a reconnecting client to get its old
    // ID back.
    const clientId = randomUUID();
    const connection = new Connection({
      socket,
      clientId,
      backpressureThresholdBytes: this.#config.backpressureThresholdBytes,
      logger: this.#logger,
    });
    connection.roomId = decoded.roomId;
    this.#connections.add(connection);
    const room = this.#rooms.join(decoded.roomId, connection);
    connection.send(encodeWelcome(clientId));

    // A newly-joined client needs to know who's already here before it has
    // any way to ask — presence for existing members doesn't otherwise
    // reach a client that wasn't connected when those updates went out.
    for (const entry of room.presence.entries()) {
      connection.send(encodePresenceBroadcast(entry.elementId, entry.timestamp, entry.value));
    }

    this.#logger.info({ clientId, roomId: decoded.roomId }, 'client joined room');
    return connection;
  }

  #handleMessage(connection: Connection, decoded: DecodedMessage): void {
    if (!connection.roomId) return;
    const room = this.#rooms.getRoom(connection.roomId);
    if (!room) return;

    switch (decoded.type) {
      case MessageType.Pong:
        connection.missedPongs = 0;
        return;

      case MessageType.SyncStep1:
        this.#handleSyncStep1(connection, room, decoded.stateVector);
        return;

      case MessageType.DocUpdate:
        this.#handleDocUpdate(connection, room, decoded.update);
        return;

      case MessageType.PresenceUpdate:
        this.#handlePresenceUpdate(connection, room, decoded.value);
        return;

      case MessageType.Hello:
        connection.disconnect(CloseCode.BadMessage, 'unexpected HELLO after handshake');
        return;

      case MessageType.Welcome:
      case MessageType.Ping:
      case MessageType.SyncStep2:
      case MessageType.PresenceBroadcast:
      case MessageType.PresenceRemove:
        // Server-to-client-only message types; a client sending one of
        // these is violating the protocol direction, not just sending
        // something we ignore.
        connection.disconnect(CloseCode.BadMessage, 'unexpected message type after handshake');
        return;
    }
  }

  #handleSyncStep1(connection: Connection, room: Room, stateVector: Uint8Array): void {
    let diff: Uint8Array;
    try {
      // Yjs updates are commutative and idempotent: applying the same
      // update twice, or in a different order relative to other updates,
      // produces the same document state either way. That's what makes it
      // safe to compute this diff against a state vector that might be
      // stale by the time it arrives, and to apply/broadcast updates below
      // without a global ordering — the CRDT guarantees convergence
      // regardless.
      diff = Y.encodeStateAsUpdate(room.doc, stateVector);
    } catch (err) {
      this.#logger.warn({ err, clientId: connection.clientId }, 'invalid state vector in SYNC_STEP1');
      connection.disconnect(CloseCode.BadMessage, 'invalid state vector');
      return;
    }
    connection.send(encodeSyncStep2(diff));
  }

  #handleDocUpdate(connection: Connection, room: Room, update: Uint8Array): void {
    try {
      Y.applyUpdate(room.doc, update, connection.clientId);
    } catch (err) {
      this.#logger.warn({ err, clientId: connection.clientId }, 'invalid Yjs update');
      connection.disconnect(CloseCode.BadMessage, 'invalid document update');
      return;
    }
    this.#rooms.broadcast(room.id, encodeDocUpdate(update), connection.clientId);
  }

  #handlePresenceUpdate(connection: Connection, room: Room, value: PresenceValue): void {
    // Timestamp is stamped here, on receipt, not taken from the client.
    // LWW's correctness depends entirely on comparable timestamps; a
    // client with a fast clock could otherwise write an update no other
    // client could ever beat. See docs/adr/0001-presence-lww-set.md.
    const timestamp = Date.now();
    room.presence.add(connection.clientId, value, timestamp, connection.clientId);
    this.#rooms.broadcast(room.id, encodePresenceBroadcast(connection.clientId, timestamp, value), connection.clientId);
  }

  #handleDeparture(connection: Connection): void {
    if (!connection.roomId) return;
    const room = this.#rooms.getRoom(connection.roomId);
    if (room) {
      const timestamp = Date.now();
      room.presence.remove(connection.clientId, timestamp, connection.clientId);
      this.#rooms.broadcast(room.id, encodePresenceRemove(connection.clientId, timestamp), connection.clientId);
    }
    this.#rooms.leave(connection.roomId, connection.clientId);
  }

  #tickHeartbeat(): void {
    for (const connection of this.#connections) {
      if (connection.missedPongs >= this.#config.heartbeatMaxMissedPongs) {
        this.#logger.info({ clientId: connection.clientId }, 'heartbeat timeout');
        connection.disconnect(CloseCode.HeartbeatTimeout, 'heartbeat timeout');
        continue;
      }
      connection.missedPongs += 1;
      connection.send(encodePing());
    }
  }

  /** Sends a close frame with CloseCode.ServerGoingAway to every connected
   * client so they reconnect promptly (elsewhere, once this instance is
   * gone) instead of waiting out a heartbeat timeout, then tears down the
   * heartbeat loop and the WebSocket server itself. */
  async shutdown(): Promise<void> {
    clearInterval(this.#heartbeatTimer);
    for (const connection of this.#connections) {
      connection.disconnect(CloseCode.ServerGoingAway, 'server going away');
    }
    await new Promise<void>((resolve, reject) => {
      this.#wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

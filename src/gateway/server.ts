import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { RoomManager } from '../room/RoomManager.js';
import { Connection } from './connection.js';
import {
  CloseCode,
  MessageType,
  PROTOCOL_VERSION,
  ProtocolDecodeError,
  decode,
  encodeMessage,
  encodePing,
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
      if (connection.roomId) this.#rooms.leave(connection.roomId, connection.clientId);
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
    this.#rooms.join(decoded.roomId, connection);
    connection.send(encodeWelcome(clientId));
    this.#logger.info({ clientId, roomId: decoded.roomId }, 'client joined room');
    return connection;
  }

  #handleMessage(connection: Connection, decoded: DecodedMessage): void {
    switch (decoded.type) {
      case MessageType.Pong:
        connection.missedPongs = 0;
        return;
      case MessageType.Message: {
        if (!connection.roomId) return;
        this.#rooms.broadcast(connection.roomId, encodeMessage(decoded.payload), connection.clientId);
        return;
      }
      case MessageType.Hello:
        connection.disconnect(CloseCode.BadMessage, 'unexpected HELLO after handshake');
        return;
      case MessageType.Welcome:
      case MessageType.Ping:
        connection.disconnect(CloseCode.BadMessage, `unexpected message type after handshake`);
        return;
    }
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

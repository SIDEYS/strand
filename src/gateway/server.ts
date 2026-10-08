import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from 'pino';
import * as Y from 'yjs';
import type { Config } from '../config.js';
import type { PresenceValue } from '../presence/types.js';
import { RoomManager } from '../room/RoomManager.js';
import type { Persistence } from '../persistence/persistence.js';
import { PERSISTED_ORIGIN, REMOTE_ORIGIN, type Room } from '../room/Room.js';
import { signResumeToken, verifyResumeToken } from '../session/resumeToken.js';
import { HybridClock } from '../transport/clock.js';
import type { Replicator } from '../transport/replicator.js';
import { makeOwnerId } from '../transport/sessionStore.js';
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
  encodeResumeToken,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeDocUpdate,
  encodeWelcome,
  type DecodedMessage,
} from '../protocol/index.js';

export interface GatewayServerOptions {
  server: HttpServer;
  config: Config;
  logger: Logger;
  /** Cross-instance replication. Omit to run as a standalone instance. */
  fanout?: Replicator;
  /** Write-behind persistence. Omit to keep rooms in memory only. */
  persistence?: Persistence;
  clock?: HybridClock;
}

/**
 * Owns the WebSocket upgrade path, the HELLO handshake, message dispatch,
 * and the room-broadcast wiring for a single instance. Cross-instance
 * fan-out (Phase 3) sits behind RoomManager, not here — this class only
 * ever needs to know about connections local to this process.
 */
export class GatewayServer {
  #wss: WebSocketServer;
  #rooms: RoomManager;
  #connections = new Set<Connection>();
  #config: Config;
  #logger: Logger;
  #heartbeatTimer: NodeJS.Timeout;
  #fanout: Replicator | undefined;
  #persistence: Persistence | undefined;
  #clock: HybridClock;

  constructor(options: GatewayServerOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#fanout = options.fanout;
    this.#persistence = options.persistence;
    this.#clock = options.clock ?? new HybridClock();
    this.#rooms = new RoomManager({
      onRoomCreated: (room) => this.#onRoomCreated(room),
      onRoomDestroyed: (room) => {
        void this.#fanout?.detachRoom(room.id);
        // The room's state is about to leave memory: write out anything it
        // still owes first.
        void this.#persistence?.detachRoom(room);
      },
    });
    this.#fanout?.bind(
      (roomId) => this.#rooms.getRoom(roomId),
      (roomId, clientId, newOwnerId) => {
        const holder = this.#rooms.getRoom(roomId)?.members.get(clientId);
        if (holder instanceof Connection && holder.ownerId !== newOwnerId) this.#supersede(holder);
      },
    );
    this.#fanout?.start();
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
    let handshaking = false;

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

      if (connection) {
        this.#handleMessage(connection, decoded);
        return;
      }
      if (handshaking) {
        // The handshake now awaits Redis, so there is a window where the
        // client hasn't been welcomed yet. A well-behaved client waits for
        // WELCOME before sending anything.
        socket.close(CloseCode.BadMessage, 'message sent before WELCOME');
        return;
      }
      handshaking = true;
      this.#handleHandshake(socket, decoded, (joined) => {
        // Assigned synchronously at the moment of joining the room, so a
        // close arriving right after can never miss the departure.
        connection = joined;
      }).catch((err: unknown) => {
        this.#logger.error({ err }, 'handshake failed');
        socket.close(1011, 'handshake failed');
      });
    });

    socket.on('close', () => {
      if (connection) this.#handleDeparture(connection);
    });

    socket.on('error', (err) => {
      this.#logger.warn({ err }, 'socket error');
    });
  }

  async #handleHandshake(
    socket: WebSocket,
    decoded: DecodedMessage,
    assign: (connection: Connection) => void,
  ): Promise<void> {
    if (decoded.type !== MessageType.Hello) {
      socket.close(CloseCode.BadMessage, 'expected HELLO as first message');
      return;
    }
    if (decoded.protocolVersion !== PROTOCOL_VERSION || decoded.roomId === null) {
      socket.close(CloseCode.ProtocolVersionMismatch, `server speaks protocol version ${PROTOCOL_VERSION}`);
      return;
    }
    if (decoded.roomId.length === 0) {
      socket.close(CloseCode.BadMessage, 'roomId must not be empty');
      return;
    }
    const roomId = decoded.roomId;

    // A client ID is never taken from the client's say-so. The only way to
    // have a specific one is a resume token this deployment signed for this
    // exact client ID and room, and an expired, forged, or wrong-room token
    // is not an error: the client just becomes a new user, which is also
    // what a client whose token lapsed during a long outage should be.
    let clientId: string = randomUUID();
    let resumed = false;
    if (decoded.resumeToken !== null) {
      const verdict = verifyResumeToken(this.#config.resumeSecret, decoded.resumeToken, roomId, Date.now());
      if (verdict.ok) {
        clientId = verdict.claims.clientId;
        resumed = true;
      } else {
        this.#logger.debug({ reason: verdict.reason, roomId }, 'resume token rejected; joining as a new user');
      }
    }

    const connection = new Connection({
      socket,
      clientId,
      ownerId: makeOwnerId(this.#config.instanceId, randomUUID()),
      backpressureThresholdBytes: this.#config.backpressureThresholdBytes,
      logger: this.#logger,
    });
    connection.roomId = roomId;

    // A token can be presented more than once (two tabs restored after a
    // crash, or a replay), and a stateless token cannot tell. Uniqueness is
    // enforced against live state instead: newest wins, and the older
    // connection is fenced. Local first, then through the shared lease for
    // connections on other instances (ADR 0003).
    if (resumed) this.#fenceLocalDuplicate(roomId, clientId, connection);
    await this.#fanout?.claimSession(roomId, clientId, connection.ownerId);
    if (socket.readyState !== socket.OPEN) {
      // The client gave up while we were waiting on Redis.
      this.#fanout?.releaseSession(roomId, clientId, connection.ownerId);
      return;
    }
    // Re-checked after the await: another resume of the same ID may have
    // finished joining while this one waited.
    if (resumed) this.#fenceLocalDuplicate(roomId, clientId, connection);

    this.#connections.add(connection);
    assign(connection);
    const room = this.#rooms.join(roomId, connection);
    if (resumed) void this.#fanout?.restorePresence(room, clientId);

    connection.send(encodeWelcome(clientId, resumed));
    this.#sendResumeToken(connection);

    // A newly-joined client needs to know who's already here before it has
    // any way to ask — presence for existing members doesn't otherwise
    // reach a client that wasn't connected when those updates went out.
    // Waits for the room to have caught up with peers so a client joining an
    // instance that has never hosted this room isn't shown an empty one.
    void room.ready.then(() => {
      for (const entry of room.presence.entries()) {
        if (entry.elementId === clientId) continue;
        connection.send(encodePresenceBroadcast(entry.elementId, entry.timestamp, entry.value));
      }
    });

    this.#logger.info({ clientId, roomId, resumed }, 'client joined room');
  }

  /** Fences any other local connection holding `clientId`. */
  #fenceLocalDuplicate(roomId: string, clientId: string, except: Connection): void {
    const existing = this.#rooms.getRoom(roomId)?.members.get(clientId);
    if (existing instanceof Connection && existing !== except) this.#supersede(existing);
  }

  /** Closes a connection that a newer one has replaced. Marked first so that
   * from this moment it is inert: its input is ignored, and its departure
   * leaves presence and the room slot alone because the client is still
   * here, on the connection that replaced it. */
  #supersede(connection: Connection): void {
    if (connection.superseded || connection.departed) return;
    connection.superseded = true;
    this.#logger.info({ clientId: connection.clientId, roomId: connection.roomId }, 'connection superseded');
    connection.disconnect(CloseCode.Superseded, 'session resumed by a newer connection');
  }

  #sendResumeToken(connection: Connection): void {
    if (connection.roomId === null) return;
    const now = Date.now();
    connection.tokenIssuedAt = now;
    connection.send(
      encodeResumeToken(
        signResumeToken(this.#config.resumeSecret, {
          clientId: connection.clientId,
          roomId: connection.roomId,
          issuedAt: now,
          expiresAt: now + this.#config.resumeTtlMs,
        }),
      ),
    );
  }

  #handleMessage(connection: Connection, decoded: DecodedMessage): void {
    if (connection.superseded || !connection.roomId) return;
    const room = this.#rooms.getRoom(connection.roomId);
    if (!room) return;

    switch (decoded.type) {
      case MessageType.Pong:
        connection.missedPongs = 0;
        // The client being alive is exactly what presence liveness tracks.
        this.#fanout?.refreshPresence(room, connection.clientId);
        // This is what actually guarantees a fenced connection stops: the
        // fence message sent at claim time can be lost, but the lease cannot
        // lie. Finding another owner here bounds how long two connections
        // can both act as this client to one heartbeat interval.
        void this.#fanout?.touchSession(room.id, connection.clientId, connection.ownerId).then((owned) => {
          if (!owned) this.#supersede(connection);
        });
        return;

      case MessageType.SyncStep1:
        void room.ready.then(() => this.#handleSyncStep1(connection, room, decoded.stateVector));
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
      case MessageType.ResumeToken:
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
    // The other half of the exchange. Without the server's state vector a
    // client that may hold edits the server lacks (anything typed while it
    // was disconnected) has nothing to diff against and would have to push
    // its whole document. With it, the client sends exactly what's missing.
    connection.send(encodeSyncStep1(Y.encodeStateVector(room.doc)));
    // From here on, document updates are delivered to this client. This runs
    // in the same tick as the diff above, so nothing can slip between them.
    connection.awaitingSync = false;
  }

  #handleDocUpdate(connection: Connection, room: Room, update: Uint8Array): void {
    // Delivery to other local clients and publication to other instances
    // both happen in #onDocUpdate, off the doc's own update event, so a
    // client's edit and an update healed in from a peer take the same path.
    try {
      Y.applyUpdate(room.doc, update, connection.clientId);
    } catch (err) {
      this.#logger.warn({ err, clientId: connection.clientId }, 'invalid Yjs update');
      connection.disconnect(CloseCode.BadMessage, 'invalid document update');
    }
  }

  #onRoomCreated(room: Room): void {
    room.doc.on('update', (update: Uint8Array, origin: unknown) => this.#onDocUpdate(room, update, origin));
    // Both load in parallel and both are CRDT merges, so neither has to wait
    // for the other for correctness. Joiners wait for both so they are not
    // shown a room that is still filling in.
    const recovered = this.#persistence?.attachRoom(room) ?? Promise.resolve();
    const replicated = this.#fanout?.attachRoom(room) ?? Promise.resolve();
    room.ready = Promise.all([recovered, replicated]).then(() => undefined);
  }

  /** The single place a document change leaves this instance. Applied
   * locally first, then published: clients here see their own edits at
   * local latency, never waiting on a Redis round trip. Yjs only fires this
   * for updates that actually changed the doc, so a duplicate delivery does
   * nothing here, and REMOTE_ORIGIN keeps an update that arrived from a
   * peer from being published straight back out. */
  #onDocUpdate(room: Room, update: Uint8Array, origin: unknown): void {
    const frame = encodeDocUpdate(update);
    // Neither a peer's update nor state read back from Postgres is ours to
    // publish: the first is already being fanned out by its origin, and the
    // second is this instance's own database read.
    if (origin === REMOTE_ORIGIN || origin === PERSISTED_ORIGIN) {
      room.broadcastDocUpdate(frame);
      return;
    }
    room.broadcastDocUpdate(frame, typeof origin === 'string' ? origin : undefined);
    this.#fanout?.publishDocUpdate(room.id, update);
  }

  #handlePresenceUpdate(connection: Connection, room: Room, value: PresenceValue): void {
    // Timestamp is stamped here, on receipt, not taken from the client.
    // LWW's correctness depends entirely on comparable timestamps; a
    // client with a fast clock could otherwise write an update no other
    // client could ever beat. See docs/adr/0001-presence-lww-set.md.
    const timestamp = this.#clock.now();
    room.presence.add(connection.clientId, value, timestamp, connection.clientId);
    room.broadcast(encodePresenceBroadcast(connection.clientId, timestamp, value), connection.clientId);
    this.#fanout?.publishPresence(room.id, connection.clientId, timestamp, value);
  }

  #handleDeparture(connection: Connection): void {
    if (connection.departed || !connection.roomId) return;
    connection.departed = true;
    this.#connections.delete(connection);
    const room = this.#rooms.getRoom(connection.roomId);

    // If a newer connection holds this client ID the person is still here;
    // this is just the old connection finally going away. Removing presence
    // or releasing the lease now would erase the successor's.
    const replaced = connection.superseded || room?.members.get(connection.clientId) !== connection;
    if (room && !replaced) {
      if (room.presence.has(connection.clientId)) {
        const timestamp = this.#clock.now();
        room.presence.remove(connection.clientId, timestamp, connection.clientId);
        room.broadcast(encodePresenceRemove(connection.clientId, timestamp), connection.clientId);
        this.#fanout?.publishPresenceRemove(room.id, connection.clientId, timestamp);
      }
      this.#fanout?.releaseSession(room.id, connection.clientId, connection.ownerId);
    }
    this.#rooms.leave(connection.roomId, connection.clientId, connection);
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
      // A connection that stays up longer than a token lives must still end
      // up holding a valid one, or its next reconnect would be a new user.
      if (!connection.superseded && Date.now() - connection.tokenIssuedAt > this.#config.resumeTtlMs / 2) {
        this.#sendResumeToken(connection);
      }
    }
  }

  /** Sends a close frame with CloseCode.ServerGoingAway to every connected
   * client so they reconnect promptly (elsewhere, once this instance is
   * gone) instead of waiting out a heartbeat timeout, then tears down the
   * heartbeat loop and the WebSocket server itself. */
  async shutdown(): Promise<void> {
    clearInterval(this.#heartbeatTimer);
    for (const connection of [...this.#connections]) {
      // Depart explicitly rather than waiting for each socket's close
      // event: those can land after the fan-out connection is gone, which
      // would leave this instance's clients to linger as ghosts until their
      // presence TTL expired.
      this.#handleDeparture(connection);
      connection.disconnect(CloseCode.ServerGoingAway, 'server going away');
    }
    await new Promise<void>((resolve, reject) => {
      this.#wss.close((err) => (err ? reject(err) : resolve()));
    });
    // Persist before the fan-out connection goes: a clean stop should leave
    // nothing unwritten, which is the window a crash cannot close.
    await this.#persistence?.close();
    await this.#fanout?.close();
  }
}

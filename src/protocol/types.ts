/**
 * Wire format (see codec.ts for the encoder/decoder):
 *
 *   [type: u8][payload...]
 *
 * `type` selects the variant below. Every payload layout is defined per
 * message in codec.ts. Protocol versioning is NOT a per-frame field — it
 * lives only in the HELLO handshake payload, because that is the one point
 * where a client and server negotiate whether they can talk to each other
 * at all. Once a connection is past HELLO/WELCOME, both sides are known to
 * agree on PROTOCOL_VERSION, so repeating it on every frame would be dead
 * weight.
 */

/** v2: HELLO carries an optional resume token, WELCOME says whether the
 * session was resumed, and the server may now send SyncStep1 to a client.
 * v3: presence positions are encoded Yjs relative positions instead of
 * integer offsets, and WELCOME carries the server's heartbeat interval.
 * A client on an older version is turned away with
 * CloseCode.ProtocolVersionMismatch before any of that is parsed. */
export const PROTOCOL_VERSION = 3;

/** Hard cap on a single inbound frame's payload. Mirrors the outbound
 * backpressure threshold in the gateway: an unbounded inbound path is the
 * same risk in the other direction, just paid for in server memory instead
 * of client memory. */
export const MAX_INBOUND_MESSAGE_BYTES = 65536;

export const MessageType = {
  /** client -> server: request to join a room. */
  Hello: 0x01,
  /** server -> client: room joined, here is your server-assigned identity. */
  Welcome: 0x02,
  /** server -> client: liveness probe. */
  Ping: 0x03,
  /** client -> server: liveness reply. */
  Pong: 0x04,
  /** server -> client: a signed token the client presents in its next HELLO
   * to reclaim this identity. Sent after WELCOME and re-sent before it
   * would expire, so a long-lived connection never holds a stale one. */
  ResumeToken: 0x05,

  /** Either direction. Client -> server, right after WELCOME: "here is my
   * Yjs state vector, send me what I'm missing." The server answers with
   * SyncStep2 and then sends its own SyncStep1, so the client can reply
   * with a DocUpdate holding only what the server lacks: reconnect costs
   * what was missed, not the size of the document. The server withholds
   * DocUpdates from a client until it has answered that client's SyncStep1,
   * so a client must send one to receive document updates at all. */
  SyncStep1: 0x10,
  /** server -> client, reply to SyncStep1: a Yjs update containing only
   * what the client's state vector didn't already have. */
  SyncStep2: 0x11,
  /** either direction: a Yjs document update. Commutative and idempotent
   * (see room/Room.ts), so the server can apply-then-rebroadcast without
   * caring about arrival order or duplicate delivery. */
  DocUpdate: 0x12,

  /** client -> server: this client's own cursor/selection/name/colour.
   * Carries no ID or timestamp — the server stamps both on receipt (see
   * docs/adr/0001-presence-lww-set.md for why client-supplied timestamps
   * are unsafe here). */
  PresenceUpdate: 0x20,
  /** server -> client: a presence entry (someone's cursor moved, or this
   * is part of the snapshot a newly-joined client gets of who's already
   * in the room). */
  PresenceBroadcast: 0x21,
  /** server -> client: a presence entry was removed (its owner
   * disconnected). */
  PresenceRemove: 0x22,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * Application-level WebSocket close codes, in the private-use range
 * (4000-4999, see RFC 6455 §7.4.2). Defined once, up front, so the client's
 * reconnect logic can branch on *why* the socket closed instead of always
 * guessing. Three classes matter to a client (the policy itself lives in
 * reconnect.ts):
 *
 *   - retry promptly: ServerGoingAway (another instance is fine)
 *   - retry with backoff: HeartbeatTimeout, BackpressureDisconnect, and any
 *     transport failure
 *   - do not retry: ProtocolVersionMismatch, BadMessage, MessageTooLarge
 *     (the same request will fail the same way, so retrying is a
 *     self-inflicted DoS), and Superseded (another connection now owns this
 *     identity; retrying would just make two tabs evict each other forever)
 */
export const CloseCode = {
  /** Graceful shutdown (SIGTERM): come back, another instance will take you. */
  ServerGoingAway: 4000,
  /** HELLO declared a version this server does not speak. */
  ProtocolVersionMismatch: 4001,
  /** Server missed too many consecutive pongs; connection presumed dead. */
  HeartbeatTimeout: 4002,
  /** Client's outbound send queue exceeded the buffered-bytes threshold. */
  BackpressureDisconnect: 4003,
  /** Frame failed to parse: unknown type byte, truncated payload, etc. */
  BadMessage: 4004,
  /** Inbound frame exceeded MAX_INBOUND_MESSAGE_BYTES. */
  MessageTooLarge: 4005,
  /** A newer connection resumed this client's identity; this one is fenced. */
  Superseded: 4006,
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

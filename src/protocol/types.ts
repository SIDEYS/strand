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

export const PROTOCOL_VERSION = 1;

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
  /** either direction: opaque room payload, rebroadcast to other room
   * members as-is. Phase 1 uses this only to prove the broadcast plumbing
   * works; Phase 2 gives it real meaning (Yjs updates, presence). */
  Message: 0x05,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * Application-level WebSocket close codes, in the private-use range
 * (4000-4999, see RFC 6455 §7.4.2). Defined once, up front, so the client's
 * reconnect logic can branch on *why* the socket closed instead of always
 * guessing. The two buckets that matter to a client:
 *
 *   - "reconnect immediately": ServerGoingAway, HeartbeatTimeout
 *   - "reconnect will just fail the same way again, back off / surface an
 *     error instead": ProtocolVersionMismatch, BackpressureDisconnect,
 *     BadMessage, MessageTooLarge
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
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

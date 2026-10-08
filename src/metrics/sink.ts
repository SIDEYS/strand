import { CloseCode } from '../protocol/index.js';

export type DisconnectReason =
  | 'going_away'
  | 'version_mismatch'
  | 'heartbeat_timeout'
  | 'backpressure'
  | 'bad_message'
  | 'message_too_large'
  | 'superseded'
  | 'client_closed'
  | 'other';

export type HandshakeResult = 'new' | 'resumed' | 'token_rejected';

export type UpdateOrigin = 'local' | 'remote' | 'persisted';

/** Maps a close code the server sent to the label it is counted under. */
export function disconnectReason(code: number): DisconnectReason {
  switch (code) {
    case CloseCode.ServerGoingAway:
      return 'going_away';
    case CloseCode.ProtocolVersionMismatch:
      return 'version_mismatch';
    case CloseCode.HeartbeatTimeout:
      return 'heartbeat_timeout';
    case CloseCode.BackpressureDisconnect:
      return 'backpressure';
    case CloseCode.BadMessage:
      return 'bad_message';
    case CloseCode.MessageTooLarge:
      return 'message_too_large';
    case CloseCode.Superseded:
      return 'superseded';
    default:
      return 'other';
  }
}

/**
 * Everything the server reports about itself. The gateway, replicator, and
 * persistence code call this interface and know nothing about Prometheus, so
 * tests can pass a recording sink and the default costs nothing.
 */
export interface MetricsSink {
  disconnect(reason: DisconnectReason): void;
  handshake(result: HandshakeResult): void;
  docUpdate(origin: UpdateOrigin): void;
  /** How long a PUBLISH to Redis took, in seconds. */
  fanoutPublished(seconds: number): void;
  /** Time from an update being published by its origin instance to this
   * instance receiving it, in seconds. Compares two machines' wall clocks, so
   * it is only as accurate as their clock sync; negative values read as 0. */
  fanoutReceived(seconds: number): void;
  snapshot(seconds: number): void;
  snapshotConflict(): void;
  opsDropped(count: number): void;
  opsCompacted(count: number): void;
  flushFailed(): void;
}

export const noopMetrics: MetricsSink = {
  disconnect() {},
  handshake() {},
  docUpdate() {},
  fanoutPublished() {},
  fanoutReceived() {},
  snapshot() {},
  snapshotConflict() {},
  opsDropped() {},
  opsCompacted() {},
  flushFailed() {},
};

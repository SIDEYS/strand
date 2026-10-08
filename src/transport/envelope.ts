import { ProtocolDecodeError, Reader, concat, writeString, writeU32, writeU64 } from '../protocol/codec.js';

/**
 * What actually travels on a room's Redis channel between instances:
 *
 *   [version: u8][kind: u8][origin: string][target: string][sentAt: u64][body...]
 *
 * `origin` is the publishing instance's ID. Redis delivers a publisher's own
 * messages back to it if it is subscribed to the channel (it always is, for
 * rooms it hosts), so every subscriber drops origin === self. That check is
 * the loop prevention; nothing about applying updates idempotently is
 * relied on for it.
 *
 * `target` is empty for "everyone", or one instance ID for a reply that
 * only that instance should act on (reconciliation answers go to the
 * instance that asked, not the whole fleet).
 *
 * `sentAt` is the publisher's wall clock in epoch milliseconds. It exists only
 * so the receiver can histogram how long fan-out took; nothing uses it for
 * ordering or correctness, because wall clocks on different machines disagree.
 */
export const ENVELOPE_VERSION = 2;

export const EnvelopeKind = {
  /** body is a client-protocol frame (DocUpdate, SyncStep2, PresenceBroadcast, PresenceRemove). */
  Frame: 0,
  /** body is a reconciliation request; see ReconcileBody. */
  Reconcile: 1,
  /** body is [clientId][newOwnerId]: a newer connection has taken over this
   * client ID, so any connection holding it under a different owner ID must
   * be closed. Lossy like everything here; the lease check on heartbeat is
   * what guarantees a fenced connection eventually notices. */
  Fence: 2,
} as const;

export const DELETE_SET_DIGEST_BYTES = 16;

interface EnvelopeBase {
  origin: string;
  target: string;
  sentAt: number;
}

export type Envelope =
  | (EnvelopeBase & { kind: typeof EnvelopeKind.Frame; frame: Uint8Array })
  | (EnvelopeBase & { kind: typeof EnvelopeKind.Fence; clientId: string; newOwnerId: string })
  | (EnvelopeBase & {
      kind: typeof EnvelopeKind.Reconcile;
      /** A joining instance wants a reply even if it looks converged: it
       * cannot otherwise tell "nobody has anything for me" from "nobody
       * answered." */
      isJoin: boolean;
      stateVector: Uint8Array;
      /** Hash of the document's delete set. A state vector alone cannot
       * reveal a lost deletion: deleting text adds no structs, so the vector
       * is unchanged. Without this, backspacing over a dropped message would
       * leave a replica showing deleted text forever. */
      deleteSetDigest: Uint8Array;
    });

function header(kind: number, origin: string, target: string, sentAt: number): Uint8Array[] {
  const chunks: Uint8Array[] = [new Uint8Array([ENVELOPE_VERSION, kind])];
  writeString(chunks, origin);
  writeString(chunks, target);
  writeU64(chunks, sentAt);
  return chunks;
}

export function encodeFrameEnvelope(
  origin: string,
  target: string,
  frame: Uint8Array,
  sentAt: number = Date.now(),
): Uint8Array {
  return concat([...header(EnvelopeKind.Frame, origin, target, sentAt), frame]);
}

export function encodeFenceEnvelope(
  origin: string,
  target: string,
  clientId: string,
  newOwnerId: string,
  sentAt: number = Date.now(),
): Uint8Array {
  const chunks = header(EnvelopeKind.Fence, origin, target, sentAt);
  writeString(chunks, clientId);
  writeString(chunks, newOwnerId);
  return concat(chunks);
}

export function encodeReconcileEnvelope(
  origin: string,
  target: string,
  isJoin: boolean,
  stateVector: Uint8Array,
  deleteSetDigest: Uint8Array,
  sentAt: number = Date.now(),
): Uint8Array {
  if (deleteSetDigest.length !== DELETE_SET_DIGEST_BYTES) {
    throw new ProtocolDecodeError(`delete set digest must be ${DELETE_SET_DIGEST_BYTES} bytes`);
  }
  const chunks = header(EnvelopeKind.Reconcile, origin, target, sentAt);
  chunks.push(new Uint8Array([isJoin ? 1 : 0]));
  writeU32(chunks, stateVector.length);
  chunks.push(stateVector, deleteSetDigest);
  return concat(chunks);
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const reader = new Reader(bytes);
  const version = reader.u8();
  if (version !== ENVELOPE_VERSION) {
    // Mixed-version fleet mid-deploy: drop rather than guess at a layout we
    // don't know. Callers treat a throw as "ignore this message".
    throw new ProtocolDecodeError(`unsupported envelope version ${version}`);
  }
  const kind = reader.u8();
  const origin = reader.string();
  const target = reader.string();
  const sentAt = reader.u64();
  switch (kind) {
    case EnvelopeKind.Frame:
      return { kind, origin, target, sentAt, frame: reader.rest() };
    case EnvelopeKind.Fence:
      return { kind, origin, target, sentAt, clientId: reader.string(), newOwnerId: reader.string() };
    case EnvelopeKind.Reconcile: {
      const isJoin = reader.u8() === 1;
      const stateVector = reader.bytes(reader.u32());
      const deleteSetDigest = reader.bytes(DELETE_SET_DIGEST_BYTES);
      return { kind, origin, target, sentAt, isJoin, stateVector, deleteSetDigest };
    }
    default:
      throw new ProtocolDecodeError(`unknown envelope kind ${kind}`);
  }
}

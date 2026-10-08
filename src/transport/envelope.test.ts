import { describe, expect, it } from 'vitest';
import { ProtocolDecodeError } from '../protocol/codec.js';
import { encodeDocUpdate } from '../protocol/index.js';
import {
  DELETE_SET_DIGEST_BYTES,
  ENVELOPE_VERSION,
  EnvelopeKind,
  decodeEnvelope,
  encodeFenceEnvelope,
  encodeFrameEnvelope,
  encodeReconcileEnvelope,
} from './envelope.js';

describe('envelope', () => {
  it('round-trips a frame envelope, preserving origin, target, and the wrapped frame', () => {
    const frame = encodeDocUpdate(new Uint8Array([1, 2, 3]));
    const decoded = decodeEnvelope(encodeFrameEnvelope('instance-a', '', frame));
    expect(decoded.kind).toBe(EnvelopeKind.Frame);
    if (decoded.kind !== EnvelopeKind.Frame) throw new Error('unreachable');
    expect(decoded.origin).toBe('instance-a');
    expect(decoded.target).toBe('');
    expect(Array.from(decoded.frame)).toEqual(Array.from(frame));
  });

  it('round-trips a reconcile envelope', () => {
    const sv = new Uint8Array([5, 6, 7, 8]);
    const digest = new Uint8Array(DELETE_SET_DIGEST_BYTES).fill(9);
    const decoded = decodeEnvelope(encodeReconcileEnvelope('a', 'b', true, sv, digest));
    expect(decoded.kind).toBe(EnvelopeKind.Reconcile);
    if (decoded.kind !== EnvelopeKind.Reconcile) throw new Error('unreachable');
    expect(decoded).toMatchObject({ origin: 'a', target: 'b', isJoin: true });
    expect(Array.from(decoded.stateVector)).toEqual([5, 6, 7, 8]);
    expect(Array.from(decoded.deleteSetDigest)).toEqual(Array.from(digest));
  });

  it('round-trips a fence envelope', () => {
    const decoded = decodeEnvelope(encodeFenceEnvelope('inst-b', 'inst-a', 'client-1', 'inst-b/conn-2'));
    expect(decoded).toEqual({
      kind: EnvelopeKind.Fence,
      origin: 'inst-b',
      target: 'inst-a',
      clientId: 'client-1',
      newOwnerId: 'inst-b/conn-2',
    });
  });

  it('rejects an unknown envelope version instead of misparsing it', () => {
    const bytes = encodeFrameEnvelope('a', '', new Uint8Array([1]));
    bytes[0] = ENVELOPE_VERSION + 1;
    expect(() => decodeEnvelope(bytes)).toThrow(ProtocolDecodeError);
  });

  it('rejects a truncated reconcile body', () => {
    const full = encodeReconcileEnvelope('a', '', false, new Uint8Array([1, 2]), new Uint8Array(DELETE_SET_DIGEST_BYTES));
    expect(() => decodeEnvelope(full.subarray(0, full.length - 3))).toThrow(ProtocolDecodeError);
  });

  it('refuses to encode a digest of the wrong size', () => {
    expect(() => encodeReconcileEnvelope('a', '', false, new Uint8Array(), new Uint8Array(3))).toThrow(ProtocolDecodeError);
  });
});

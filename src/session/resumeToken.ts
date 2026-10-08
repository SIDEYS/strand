import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProtocolDecodeError, Reader, concat, writeString, writeU64 } from '../protocol/codec.js';

/**
 * A stateless resume token: four claims and one HMAC-SHA256 signature, so
 * any instance holding the shared secret can honour it without consulting
 * shared state. Deliberately not a JWT: there is exactly one algorithm
 * here, fixed in code and never read from the token, so there is no
 * algorithm-negotiation surface ("alg: none", RS256/HS256 confusion) to get
 * wrong.
 *
 *   token   = payload || mac
 *   payload = [format: u8][clientId: string][roomId: string][issuedAt: u64][expiresAt: u64]
 *   mac     = HMAC-SHA256(secret, DOMAIN || payload)
 *
 * The MAC covers the exact bytes received, so there is no re-serialisation
 * step for a canonicalisation bug to hide in.
 *
 * What the token does and does not prove: that this server issued it, for
 * this client ID in this room, and that it hasn't expired. It grants no
 * privilege (the service has no auth), so it cannot be revoked before it
 * expires, and that is acceptable only because of that. See ADR 0003.
 */
const FORMAT = 1;
const MAC_BYTES = 32;
/** Binds the MAC to this purpose so a signature made for something else
 * with the same secret can never be replayed as a resume token. */
const DOMAIN = Buffer.from('strand/resume-token/v1\0');

export interface ResumeClaims {
  clientId: string;
  roomId: string;
  issuedAt: number;
  expiresAt: number;
}

export type ResumeVerdict =
  | { ok: true; claims: ResumeClaims }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad-signature' | 'wrong-room' };

function mac(secret: Uint8Array | string, payload: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(DOMAIN).update(payload).digest();
}

export function signResumeToken(secret: Uint8Array | string, claims: ResumeClaims): Uint8Array {
  const chunks: Uint8Array[] = [new Uint8Array([FORMAT])];
  writeString(chunks, claims.clientId);
  writeString(chunks, claims.roomId);
  writeU64(chunks, claims.issuedAt);
  writeU64(chunks, claims.expiresAt);
  const payload = concat(chunks);
  return concat([payload, mac(secret, payload)]);
}

export function verifyResumeToken(
  secret: Uint8Array | string,
  token: Uint8Array,
  expectedRoomId: string,
  now: number,
): ResumeVerdict {
  if (token.length <= MAC_BYTES) return { ok: false, reason: 'malformed' };
  const payload = token.subarray(0, token.length - MAC_BYTES);
  const presented = token.subarray(token.length - MAC_BYTES);

  let claims: ResumeClaims;
  try {
    const reader = new Reader(payload);
    if (reader.u8() !== FORMAT) return { ok: false, reason: 'malformed' };
    claims = {
      clientId: reader.string(),
      roomId: reader.string(),
      issuedAt: reader.u64(),
      expiresAt: reader.u64(),
    };
    if (reader.remaining !== 0) return { ok: false, reason: 'malformed' };
  } catch (err) {
    if (err instanceof ProtocolDecodeError) return { ok: false, reason: 'malformed' };
    throw err;
  }

  // Expiry first. The claims above are still unauthenticated at this point,
  // so this is only ever used to reject: a forged "not yet expired" value
  // fails the MAC below, and a forged "expired" one is rejected either way.
  // Doing it first just spares an HMAC on the (common) stale token.
  if (now >= claims.expiresAt) return { ok: false, reason: 'expired' };

  // Constant-time: a byte-by-byte early-exit compare would let a caller
  // learn a valid MAC one byte at a time from response timing.
  if (!timingSafeEqual(mac(secret, payload), presented)) return { ok: false, reason: 'bad-signature' };

  if (claims.roomId !== expectedRoomId) return { ok: false, reason: 'wrong-room' };
  return { ok: true, claims };
}

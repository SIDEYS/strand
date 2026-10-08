import { describe, expect, it } from 'vitest';
import { signResumeToken, verifyResumeToken, type ResumeClaims } from './resumeToken.js';

const SECRET = 'a-test-secret-of-reasonable-length-123456';
const NOW = 1_000_000;
const claims: ResumeClaims = { clientId: 'client-1', roomId: 'room-1', issuedAt: NOW - 10, expiresAt: NOW + 60_000 };

describe('resume token', () => {
  it('verifies a token it signed and returns the claims', () => {
    const token = signResumeToken(SECRET, claims);
    expect(verifyResumeToken(SECRET, token, 'room-1', NOW)).toEqual({ ok: true, claims });
  });

  it('rejects an expired token', () => {
    const token = signResumeToken(SECRET, claims);
    expect(verifyResumeToken(SECRET, token, 'room-1', claims.expiresAt)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyResumeToken(SECRET, token, 'room-1', claims.expiresAt + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('checks expiry before the signature: a stale token with the wrong secret reports expired', () => {
    const token = signResumeToken('some-other-secret-entirely-0000000000', claims);
    const verdict = verifyResumeToken(SECRET, token, 'room-1', claims.expiresAt + 1);
    expect(verdict).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signResumeToken('some-other-secret-entirely-0000000000', claims);
    expect(verifyResumeToken(SECRET, token, 'room-1', NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a token presented in a different room than it was issued for', () => {
    const token = signResumeToken(SECRET, claims);
    expect(verifyResumeToken(SECRET, token, 'room-2', NOW)).toEqual({ ok: false, reason: 'wrong-room' });
  });

  it('rejects any single flipped bit anywhere in the token', () => {
    const token = signResumeToken(SECRET, claims);
    for (let byte = 0; byte < token.length; byte++) {
      for (const bit of [0, 7]) {
        const tampered = token.slice();
        tampered[byte]! ^= 1 << bit;
        const verdict = verifyResumeToken(SECRET, tampered, 'room-1', NOW);
        expect(verdict.ok, `byte ${byte} bit ${bit}`).toBe(false);
      }
    }
  });

  it('rejects a token whose expiry was extended after signing', () => {
    const token = signResumeToken(SECRET, claims);
    // expiresAt is the 8 bytes immediately before the 32-byte MAC.
    const tampered = token.slice();
    tampered[token.length - 32 - 1]! += 1;
    expect(verifyResumeToken(SECRET, tampered, 'room-1', NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects malformed input without throwing', () => {
    const token = signResumeToken(SECRET, claims);
    for (const bad of [new Uint8Array(), new Uint8Array(10), token.subarray(0, token.length - 1), token.subarray(5)]) {
      expect(verifyResumeToken(SECRET, bad, 'room-1', NOW).ok).toBe(false);
    }
  });

  it('rejects trailing bytes appended to a valid payload', () => {
    const token = signResumeToken(SECRET, claims);
    const extended = new Uint8Array(token.length + 1);
    extended.set(token.subarray(0, token.length - 32), 0);
    extended[token.length - 32] = 0;
    extended.set(token.subarray(token.length - 32), token.length - 31);
    expect(verifyResumeToken(SECRET, extended, 'room-1', NOW).ok).toBe(false);
  });

  it('does not accept a MAC computed without the domain separator', async () => {
    const { createHmac } = await import('node:crypto');
    const token = signResumeToken(SECRET, claims);
    const payload = token.subarray(0, token.length - 32);
    const naive = createHmac('sha256', SECRET).update(payload).digest();
    const forged = new Uint8Array(token.length);
    forged.set(payload, 0);
    forged.set(naive, payload.length);
    expect(verifyResumeToken(SECRET, forged, 'room-1', NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });
});

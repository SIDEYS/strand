import { CloseCode } from './types.js';

/**
 * Client reconnect policy as pure functions: no timers, no sockets, no
 * randomness of its own (it is handed a `random`). The socket-owning code
 * feeds events in and carries out the effects that come back, which makes
 * every transition testable without sleeping and lets the browser client
 * reuse the exact logic the integration tests exercise.
 */

export type CloseClass =
  /** Another instance is fine and the server asked us to leave: go now. */
  | 'immediate'
  /** Probably transient; retry, but spread out and slowing down. */
  | 'backoff'
  /** Retrying cannot help, or would do harm. Stop and tell the user. */
  | 'fatal';

export type FailureReason = 'version-mismatch' | 'protocol-error' | 'superseded';

export interface CloseVerdict {
  class: CloseClass;
  failure?: FailureReason;
}

export function classifyClose(code: number): CloseVerdict {
  switch (code) {
    case CloseCode.ServerGoingAway:
      return { class: 'immediate' };

    // The same HELLO or frame would be rejected the same way every time. A
    // client that loops on these is a denial of service against the server
    // it is talking to, started by its own stale build.
    case CloseCode.ProtocolVersionMismatch:
      return { class: 'fatal', failure: 'version-mismatch' };
    case CloseCode.BadMessage:
    case CloseCode.MessageTooLarge:
      return { class: 'fatal', failure: 'protocol-error' };

    // Not retryable on purpose. Superseded means a newer connection now owns
    // this identity, typically another tab. If this tab reconnected
    // automatically it would evict that one, which would reconnect and evict
    // this one, forever. The user decides whether to take the session back.
    case CloseCode.Superseded:
      return { class: 'fatal', failure: 'superseded' };

    // HeartbeatTimeout, BackpressureDisconnect, 1006 (transport failure),
    // 1001, and anything we don't recognise. An unknown code is more likely
    // a newer server's transient condition than a permanent one, and the
    // capped backoff bounds the harm if that guess is wrong.
    default:
      return { class: 'backoff' };
  }
}

export interface ReconnectPolicy {
  baseMs: number;
  capMs: number;
  /** Upper bound of the random delay before an 'immediate' retry, so every
   * client of a restarting instance doesn't reconnect in the same tick. */
  immediateJitterMs: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  baseMs: 500,
  capMs: 30_000,
  immediateJitterMs: 500,
};

/**
 * Exponential backoff with "equal jitter": half the ceiling is fixed and
 * half is random. Full jitter can come back near zero, which under a
 * failing server means a burst of near-instant retries; keeping a floor
 * guarantees spacing while still decorrelating clients.
 * `failures` is how many consecutive attempts have failed (>= 1).
 */
export function backoffDelay(failures: number, random: () => number, policy: ReconnectPolicy): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(Math.max(failures - 1, 0), 30));
  const half = ceiling / 2;
  return Math.floor(half + random() * half);
}

export type ConnectionState =
  | { status: 'idle' }
  | { status: 'connecting'; failures: number }
  | { status: 'connected' }
  | { status: 'reconnecting'; failures: number; delayMs: number }
  | { status: 'offline' }
  | { status: 'failed'; reason: FailureReason };

export type ConnectionEvent =
  | { type: 'start' }
  | { type: 'welcome' }
  | { type: 'closed'; code: number }
  | { type: 'network'; online: boolean }
  | { type: 'retry-due' }
  | { type: 'manual-reconnect' };

export type ConnectionEffect =
  | { kind: 'none' }
  /** Open a new socket. Implies cancelling any pending retry timer. */
  | { kind: 'connect' }
  | { kind: 'schedule-retry'; delayMs: number }
  | { kind: 'cancel-retry' };

export interface Transition {
  state: ConnectionState;
  effect: ConnectionEffect;
}

const NONE: ConnectionEffect = { kind: 'none' };

export function step(
  state: ConnectionState,
  event: ConnectionEvent,
  random: () => number,
  policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY,
): Transition {
  switch (event.type) {
    case 'start':
      if (state.status !== 'idle') return { state, effect: NONE };
      return { state: { status: 'connecting', failures: 0 }, effect: { kind: 'connect' } };

    case 'welcome':
      // Failures reset only here, on a completed handshake. An open socket
      // that is closed straight away by the server has not proven the
      // connection works and must not reset the backoff.
      if (state.status !== 'connecting') return { state, effect: NONE };
      return { state: { status: 'connected' }, effect: NONE };

    case 'closed': {
      if (state.status !== 'connecting' && state.status !== 'connected') return { state, effect: NONE };
      const verdict = classifyClose(event.code);
      if (verdict.class === 'fatal') {
        return { state: { status: 'failed', reason: verdict.failure! }, effect: { kind: 'cancel-retry' } };
      }
      const failures = (state.status === 'connecting' ? state.failures : 0) + 1;
      const delayMs =
        verdict.class === 'immediate' && failures === 1
          ? Math.floor(random() * policy.immediateJitterMs)
          : backoffDelay(failures, random, policy);
      return {
        state: { status: 'reconnecting', failures, delayMs },
        effect: { kind: 'schedule-retry', delayMs },
      };
    }

    case 'retry-due':
      if (state.status !== 'reconnecting') return { state, effect: NONE };
      return { state: { status: 'connecting', failures: state.failures }, effect: { kind: 'connect' } };

    case 'network':
      if (!event.online) {
        if (state.status === 'idle' || state.status === 'failed' || state.status === 'offline') {
          return { state, effect: NONE };
        }
        return { state: { status: 'offline' }, effect: { kind: 'cancel-retry' } };
      }
      // Coming back online is real evidence the network works, so start
      // over rather than continuing a backoff earned while it was down.
      if (state.status !== 'offline') return { state, effect: NONE };
      return { state: { status: 'connecting', failures: 0 }, effect: { kind: 'connect' } };

    case 'manual-reconnect':
      if (state.status === 'connected' || state.status === 'connecting' || state.status === 'idle') {
        return { state, effect: NONE };
      }
      return { state: { status: 'connecting', failures: 0 }, effect: { kind: 'connect' } };
  }
}

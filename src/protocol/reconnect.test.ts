import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECONNECT_POLICY,
  backoffDelay,
  classifyClose,
  step,
  type ConnectionEvent,
  type ConnectionState,
  type Transition,
} from './reconnect.js';
import { CloseCode } from './types.js';

const policy = { baseMs: 100, capMs: 1600, immediateJitterMs: 50 };
const lo = () => 0;
const hi = () => 0.999999;

function run(events: ConnectionEvent[], random: () => number = lo): Transition[] {
  let state: ConnectionState = { status: 'idle' };
  return events.map((event) => {
    const t = step(state, event, random, policy);
    state = t.state;
    return t;
  });
}

describe('classifyClose', () => {
  it('retries a server going away immediately', () => {
    expect(classifyClose(CloseCode.ServerGoingAway).class).toBe('immediate');
  });

  it('backs off after heartbeat timeout, backpressure, and transport-level failures', () => {
    for (const code of [CloseCode.HeartbeatTimeout, CloseCode.BackpressureDisconnect, 1006, 1001, 1011, 4999]) {
      expect(classifyClose(code).class, `code ${code}`).toBe('backoff');
    }
  });

  it('never retries a protocol version mismatch or a malformed/oversized message', () => {
    expect(classifyClose(CloseCode.ProtocolVersionMismatch)).toEqual({ class: 'fatal', failure: 'version-mismatch' });
    expect(classifyClose(CloseCode.BadMessage)).toEqual({ class: 'fatal', failure: 'protocol-error' });
    expect(classifyClose(CloseCode.MessageTooLarge)).toEqual({ class: 'fatal', failure: 'protocol-error' });
  });

  it('does not auto-retry a superseded session, and says why', () => {
    expect(classifyClose(CloseCode.Superseded)).toEqual({ class: 'fatal', failure: 'superseded' });
  });

  it('classifies every defined close code (a new code must be a deliberate decision)', () => {
    for (const code of Object.values(CloseCode)) {
      expect(['immediate', 'backoff', 'fatal']).toContain(classifyClose(code).class);
    }
  });
});

describe('backoffDelay', () => {
  it('keeps every delay between half the ceiling and the ceiling', () => {
    for (let failures = 1; failures <= 12; failures++) {
      const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** (failures - 1));
      expect(backoffDelay(failures, lo, policy)).toBe(Math.floor(ceiling / 2));
      expect(backoffDelay(failures, hi, policy)).toBeLessThanOrEqual(ceiling);
      expect(backoffDelay(failures, hi, policy)).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
    }
  });

  it('grows exponentially, then stops at the cap', () => {
    const ceilings = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelay(n, hi, policy));
    expect(ceilings[1]!).toBeGreaterThan(ceilings[0]!);
    expect(ceilings[3]!).toBeGreaterThan(ceilings[2]!);
    expect(backoffDelay(50, hi, policy)).toBeLessThanOrEqual(policy.capMs);
    expect(backoffDelay(1000, hi, policy)).toBeLessThanOrEqual(policy.capMs);
  });

  it('actually jitters: different random values give different delays', () => {
    expect(backoffDelay(5, lo, policy)).not.toBe(backoffDelay(5, hi, policy));
  });

  it('has sane defaults', () => {
    expect(DEFAULT_RECONNECT_POLICY.capMs).toBeGreaterThan(DEFAULT_RECONNECT_POLICY.baseMs);
  });
});

describe('connection state machine', () => {
  it('connects on start and is connected after the handshake completes', () => {
    const [start, welcome] = run([{ type: 'start' }, { type: 'welcome' }]);
    expect(start).toEqual({ state: { status: 'connecting', failures: 0 }, effect: { kind: 'connect' } });
    expect(welcome!.state).toEqual({ status: 'connected' });
  });

  it('retries almost immediately when the server says it is going away, then backs off if it keeps failing', () => {
    const t = run([
      { type: 'start' },
      { type: 'welcome' },
      { type: 'closed', code: CloseCode.ServerGoingAway },
      { type: 'retry-due' },
      { type: 'closed', code: CloseCode.ServerGoingAway },
    ]);
    const first = t[2]!;
    expect(first.effect.kind).toBe('schedule-retry');
    expect(first.effect.kind === 'schedule-retry' && first.effect.delayMs).toBeLessThan(policy.immediateJitterMs);
    // A second consecutive failure is no longer "immediate".
    const second = t[4]!;
    expect(second.state).toMatchObject({ status: 'reconnecting', failures: 2 });
    expect(second.effect.kind === 'schedule-retry' && second.effect.delayMs).toBeGreaterThanOrEqual(policy.baseMs);
  });

  it('escalates the delay across consecutive failures and resets it after a successful handshake', () => {
    const delays: number[] = [];
    let state: ConnectionState = { status: 'idle' };
    const feed = (event: ConnectionEvent) => {
      const t = step(state, event, hi, policy);
      state = t.state;
      if (t.effect.kind === 'schedule-retry') delays.push(t.effect.delayMs);
      return t;
    };
    feed({ type: 'start' });
    for (let i = 0; i < 4; i++) {
      feed({ type: 'closed', code: CloseCode.HeartbeatTimeout });
      feed({ type: 'retry-due' });
    }
    expect(delays[3]!).toBeGreaterThan(delays[0]!);

    feed({ type: 'welcome' });
    feed({ type: 'closed', code: CloseCode.HeartbeatTimeout });
    expect(delays[4]!).toBe(delays[0]!);
  });

  it('does not reset the backoff when a socket opens but is closed again before the handshake', () => {
    // No 'welcome' between the failures: the failure count must keep climbing.
    const t = run(
      [
        { type: 'start' },
        { type: 'closed', code: 1006 },
        { type: 'retry-due' },
        { type: 'closed', code: 1006 },
        { type: 'retry-due' },
        { type: 'closed', code: 1006 },
      ],
      hi,
    );
    expect(t[5]!.state).toMatchObject({ status: 'reconnecting', failures: 3 });
  });

  it('stops for good on a version mismatch: no retry is ever scheduled', () => {
    const t = run([{ type: 'start' }, { type: 'closed', code: CloseCode.ProtocolVersionMismatch }, { type: 'retry-due' }]);
    expect(t[1]!.state).toEqual({ status: 'failed', reason: 'version-mismatch' });
    expect(t[1]!.effect.kind).not.toBe('schedule-retry');
    expect(t[2]!.effect).toEqual({ kind: 'none' });
    expect(t[2]!.state).toEqual({ status: 'failed', reason: 'version-mismatch' });
  });

  it('stops on superseded, reporting it distinctly, and only a manual reconnect resumes', () => {
    const t = run([
      { type: 'start' },
      { type: 'welcome' },
      { type: 'closed', code: CloseCode.Superseded },
      { type: 'retry-due' },
      { type: 'manual-reconnect' },
    ]);
    expect(t[2]!.state).toEqual({ status: 'failed', reason: 'superseded' });
    expect(t[3]!.effect).toEqual({ kind: 'none' });
    expect(t[4]!).toEqual({ state: { status: 'connecting', failures: 0 }, effect: { kind: 'connect' } });
  });

  it('pauses while offline and reconnects from scratch when the network returns', () => {
    const t = run([
      { type: 'start' },
      { type: 'welcome' },
      { type: 'network', online: false },
      { type: 'closed', code: 1006 }, // the socket dies as a consequence; must not schedule a retry
      { type: 'network', online: true },
    ]);
    expect(t[2]!.state).toEqual({ status: 'offline' });
    expect(t[3]!.effect).toEqual({ kind: 'none' });
    expect(t[4]!).toEqual({ state: { status: 'connecting', failures: 0 }, effect: { kind: 'connect' } });
  });

  it('cancels a pending retry when the network drops while waiting to reconnect', () => {
    const t = run([{ type: 'start' }, { type: 'closed', code: 1006 }, { type: 'network', online: false }]);
    expect(t[2]!).toEqual({ state: { status: 'offline' }, effect: { kind: 'cancel-retry' } });
  });

  it('never emits connect or schedule-retry from a failed state except via manual reconnect (randomised)', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const codes = [CloseCode.ProtocolVersionMismatch, CloseCode.Superseded, 1006, CloseCode.ServerGoingAway];
    for (let trial = 0; trial < 200; trial++) {
      let state: ConnectionState = { status: 'idle' };
      for (let i = 0; i < 40; i++) {
        const pick = Math.floor(random() * 6);
        const event: ConnectionEvent =
          pick === 0 ? { type: 'welcome' }
          : pick === 1 ? { type: 'closed', code: codes[Math.floor(random() * codes.length)]! }
          : pick === 2 ? { type: 'retry-due' }
          : pick === 3 ? { type: 'network', online: random() < 0.5 }
          : pick === 4 ? { type: 'start' }
          : { type: 'manual-reconnect' };
        const before = state;
        const t = step(state, event, random, policy);
        if (before.status === 'failed' && event.type !== 'manual-reconnect') {
          expect(t.effect.kind, JSON.stringify({ before, event })).not.toBe('connect');
          expect(t.effect.kind, JSON.stringify({ before, event })).not.toBe('schedule-retry');
        }
        if (t.effect.kind === 'schedule-retry') expect(t.effect.delayMs).toBeLessThanOrEqual(policy.capMs);
        state = t.state;
      }
    }
  });
});

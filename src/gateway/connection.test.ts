import { EventEmitter } from 'node:events';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { CloseCode } from '../protocol/index.js';
import { Connection } from './connection.js';

const logger = pino({ level: 'silent' });

/** A fake `ws` socket exposing only what Connection touches, with a
 * controllable `bufferedAmount` so backpressure can be tested
 * deterministically instead of trying to actually stall a real TCP socket. */
function fakeSocket(
  bufferedAmount = 0,
  options: { completesClose?: boolean } = {},
): WebSocket & {
  bufferedAmount: number;
  sent: unknown[];
  closedWith: { code: number; reason: string } | null;
  terminated: boolean;
} {
  const completesClose = options.completesClose ?? true;
  const emitter = new EventEmitter();
  const socket = {
    bufferedAmount,
    readyState: 1, // OPEN
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    sent: [] as unknown[],
    closedWith: null as { code: number; reason: string } | null,
    terminated: false,
    send(data: unknown, cb?: (err?: Error) => void) {
      socket.sent.push(data);
      cb?.();
    },
    close(code = 1000, reason: string | Buffer = '') {
      socket.closedWith = { code, reason: reason.toString() };
      // A peer that never acks the close handshake (the case this fake is
      // built to simulate) does not flip readyState or emit 'close'.
      if (completesClose) {
        socket.readyState = socket.CLOSED;
        emitter.emit('close');
      }
    },
    terminate() {
      socket.terminated = true;
      socket.readyState = socket.CLOSED;
      emitter.emit('close');
    },
    once: emitter.once.bind(emitter),
  };
  return socket as unknown as WebSocket & typeof socket;
}

describe('Connection backpressure', () => {
  it('reports backpressured once bufferedAmount exceeds the threshold', () => {
    const socket = fakeSocket(2000);
    const connection = new Connection({ socket, clientId: 'c1', backpressureThresholdBytes: 1000, logger });
    expect(connection.isBackpressured()).toBe(true);
  });

  it('does not report backpressured below the threshold', () => {
    const socket = fakeSocket(500);
    const connection = new Connection({ socket, clientId: 'c1', backpressureThresholdBytes: 1000, logger });
    expect(connection.isBackpressured()).toBe(false);
  });

  it('disconnects with BackpressureDisconnect instead of sending when backpressured', () => {
    const socket = fakeSocket(2000);
    const connection = new Connection({ socket, clientId: 'c1', backpressureThresholdBytes: 1000, logger });

    connection.send(new Uint8Array([1, 2, 3]));

    expect(socket.sent).toHaveLength(0);
    expect(socket.closedWith).toEqual({
      code: CloseCode.BackpressureDisconnect,
      reason: 'backpressure threshold exceeded',
    });
  });

  it('sends normally when under the threshold', () => {
    const socket = fakeSocket(0);
    const connection = new Connection({ socket, clientId: 'c1', backpressureThresholdBytes: 1000, logger });

    connection.send(new Uint8Array([1, 2, 3]));

    expect(socket.sent).toHaveLength(1);
    expect(socket.closedWith).toBeNull();
  });

  it('falls back to terminate() if the peer never completes the close handshake', () => {
    vi.useFakeTimers();
    try {
      const socket = fakeSocket(0, { completesClose: false });
      const connection = new Connection({ socket, clientId: 'c1', backpressureThresholdBytes: 1000, logger });

      connection.disconnect(CloseCode.HeartbeatTimeout, 'heartbeat timeout');
      expect(socket.terminated).toBe(false);

      vi.advanceTimersByTime(2100);
      expect(socket.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CollabClient } from './core.js';
import type { ClientSocket, Scheduler } from './types.js';

const systemScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

describe('stopping a client whose socket is still connecting (real ws)', () => {
  const held: Socket[] = [];
  let server: Server | undefined;

  afterEach(async () => {
    for (const socket of held.splice(0)) socket.destroy();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  // Node's `ws` emits an `error` when a socket is terminated before its
  // handshake completes. If the client has removed every listener by then, that
  // is an uncaught exception. This found one the integration suite hit once in
  // a while in CI, when a test stopped a client mid-connect.
  it('does not raise an uncaught error', async () => {
    let accepted!: () => void;
    const connected = new Promise<void>((resolve) => (accepted = resolve));
    server = createServer((socket) => {
      held.push(socket); // take the TCP connection and never answer the upgrade
      accepted();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      const client = new CollabClient({
        roomId: 'connecting',
        url: () => `ws://127.0.0.1:${port}/ws`,
        socketFactory: (url) => new WebSocket(url) as unknown as ClientSocket,
        scheduler: systemScheduler,
        random: Math.random,
      });
      client.start();
      await connected; // TCP is up, the HTTP upgrade is unanswered: the socket is CONNECTING
      client.stop();
      // A negative assertion needs a bounded window for the error to arrive.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});

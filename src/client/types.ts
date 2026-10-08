/**
 * The seams that keep the client core free of the environment. Everything it
 * would otherwise reach for as a global (a WebSocket, a timer, the clock,
 * randomness) is handed to it instead, which is what lets the same code run
 * in a browser, under Node in integration tests, and under a fake clock in
 * unit tests that never sleep.
 */

/** The slice of a WebSocket the client uses. Both the browser's native
 * WebSocket and the `ws` library satisfy it. */
export interface ClientSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Tear down immediately with no close handshake (`ws` has it; browsers
   * do not, and fall back to close()). */
  terminate?(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => ClientSocket;

/** Time, as an injected capability. Reconnect backoff and the liveness
 * watchdog both run on it, so tests advance a fake clock instead of waiting. */
export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

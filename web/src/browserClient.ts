import { CollabClient } from '../../src/client/core.js';
import type { ClientSocket, Scheduler } from '../../src/client/types.js';

/**
 * The only place the browser's globals meet the client core. The core itself
 * touches none of them (ESLint enforces that); everything it needs from the
 * environment is handed over here.
 */
const browserScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

function tokenKey(roomId: string): string {
  return `strand:resume:${roomId}`;
}

// A resume token lives in sessionStorage, not localStorage: it identifies one
// tab's session. Two tabs sharing a token would be the duplicate-resume case
// the server fences, so each tab keeps its own, and a reload of that tab
// comes back as the same person instead of leaving a ghost behind.
function loadToken(roomId: string): Uint8Array | null {
  try {
    const stored = sessionStorage.getItem(tokenKey(roomId));
    if (!stored) return null;
    return Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function saveToken(roomId: string, token: Uint8Array): void {
  try {
    sessionStorage.setItem(tokenKey(roomId), btoa(String.fromCharCode(...token)));
  } catch {
    // Storage can be unavailable or full; resuming across a reload is a nicety.
  }
}

export function gatewayUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws`;
}

/** A started client for a room, wired to the browser's network events. */
export function createBrowserClient(roomId: string): { client: CollabClient; dispose: () => void } {
  const resumeToken = loadToken(roomId);
  const client = new CollabClient({
    roomId,
    url: gatewayUrl,
    socketFactory: (url) => new WebSocket(url) as unknown as ClientSocket,
    scheduler: browserScheduler,
    random: Math.random,
    ...(resumeToken ? { resumeToken } : {}),
    onResumeToken: (token) => saveToken(roomId, token),
  });

  const goOnline = () => client.notifyNetwork(true);
  const goOffline = () => client.notifyNetwork(false);
  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
  if (!navigator.onLine) client.notifyNetwork(false);
  client.start();

  return {
    client,
    dispose() {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      client.stop();
    },
  };
}

import { randomColor, randomDisplayName } from './routing.js';

export interface Identity {
  name: string;
  color: string;
}

const KEY = 'strand:identity';
const RECENT_KEY = 'strand:recent-rooms';

/** A name and colour that persist across visits in this browser, so you are
 * recognisably the same collaborator each time. */
export function loadIdentity(): Identity {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Identity> | null;
    if (stored && typeof stored.name === 'string' && typeof stored.color === 'string') {
      return { name: stored.name, color: stored.color };
    }
  } catch {
    // Corrupt or unavailable storage: make a fresh identity below.
  }
  const identity = { name: randomDisplayName(Math.random), color: randomColor(Math.random) };
  saveIdentity(identity);
  return identity;
}

export function saveIdentity(identity: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // Not fatal.
  }
}

export function loadRecentRooms(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function rememberRoom(roomId: string): void {
  try {
    const next = [roomId, ...loadRecentRooms().filter((r) => r !== roomId)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Not fatal.
  }
}

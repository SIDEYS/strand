/** Room IDs end up in URLs, in Redis keys, and in a Postgres column, so they
 * are restricted to a small safe alphabet instead of being escaped later. */
const MAX_ROOM_LENGTH = 64;

export function roomSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ROOM_LENGTH)
    .replace(/-+$/g, '');
}

export type Route = { page: 'picker' } | { page: 'room'; roomId: string };

export function parseRoute(pathname: string): Route {
  const match = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (!match) return { page: 'picker' };
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]!);
  } catch {
    return { page: 'picker' };
  }
  const roomId = roomSlug(decoded);
  return roomId === '' ? { page: 'picker' } : { page: 'room', roomId };
}

export function roomPath(roomId: string): string {
  return `/r/${encodeURIComponent(roomId)}`;
}

const ADJECTIVES = ['Quick', 'Calm', 'Bright', 'Quiet', 'Bold', 'Clever', 'Gentle', 'Lucky', 'Swift', 'Warm', 'Keen', 'Merry'];
const ANIMALS = ['Otter', 'Falcon', 'Heron', 'Lynx', 'Panda', 'Fox', 'Crane', 'Newt', 'Badger', 'Finch', 'Moth', 'Seal'];

/** A readable throwaway room name for "new room". `random` is injected so
 * this stays deterministic under test. */
export function randomRoomId(random: () => number): string {
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const suffix = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return roomSlug(`${pick(ADJECTIVES)}-${pick(ANIMALS)}-${suffix}`);
}

export function randomDisplayName(random: () => number): string {
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

/** Colours chosen to stay legible on both a light and a dark page. */
export const USER_COLORS = ['#e11d48', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#c026d3'] as const;

export function randomColor(random: () => number): string {
  return USER_COLORS[Math.floor(random() * USER_COLORS.length)]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
}

/** Proportional scroll sync between the editor and the preview. It maps the
 * scrolled fraction of one pane onto the other, which is approximate (it is
 * not tied to source lines) but needs no per-block bookkeeping. */
export function scrollFraction(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const scrollable = scrollHeight - clientHeight;
  return scrollable <= 0 ? 0 : Math.min(1, Math.max(0, scrollTop / scrollable));
}

export function scrollTopForFraction(fraction: number, scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight) * Math.min(1, Math.max(0, fraction));
}

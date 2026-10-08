import type { Redis } from 'ioredis';

/** `${instanceId}/${connectionId}`. The connection ID is a UUID, so the last
 * slash is always the separator even if an instance ID contains one. */
export function makeOwnerId(instanceId: string, connectionId: string): string {
  return `${instanceId}/${connectionId}`;
}

export function instanceOfOwner(ownerId: string): string {
  return ownerId.slice(0, ownerId.lastIndexOf('/'));
}

/**
 * Which live connection currently owns each client ID in a room, as a lease
 * in Redis: owner plus a deadline measured by Redis's own clock.
 *
 * This is what lets a stateless resume token still give "one live
 * connection per client ID" across instances. The token proves a client may
 * reclaim an ID; the lease decides whether that ID is already in use.
 *
 * It is a lease, not a lock, and the distinction is the whole design. A
 * lease holder can lose its lease without noticing (a Redis failover, a
 * long pause), so nothing may assume the holder is alone. Instead every
 * holder re-checks ownership on its heartbeat (`touch`) and fences itself
 * the moment it finds someone else holds the lease. The fence message sent
 * at claim time is only the fast path; the heartbeat check is what bounds
 * the time two connections can both believe they are the client.
 *
 * Why not reuse presence entries as the "already connected" signal: a
 * presence entry only exists after a client's first cursor update, so a
 * connected client that hasn't sent one would look absent and its identity
 * could be taken. The lease is written at connect, and uses the same
 * Redis-clock deadline mechanism and refresh-on-heartbeat as presence.
 */
const CLAIM = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local ttl = tonumber(ARGV[3])
local prev = redis.call('HGET', KEYS[2], ARGV[1])
local deadline = redis.call('ZSCORE', KEYS[1], ARGV[1])
local live = false
if prev and deadline and tonumber(deadline) > now then live = prev end
redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ttl * 2)
redis.call('PEXPIRE', KEYS[2], ttl * 2)
return live
`;

// Refreshes the lease if it is ours, or if nobody holds a live one (it
// expired, or Redis lost it: a live client must not be fenced because of
// that). Refuses only when a different owner holds an unexpired lease.
const TOUCH = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local ttl = tonumber(ARGV[3])
local owner = redis.call('HGET', KEYS[2], ARGV[1])
local deadline = redis.call('ZSCORE', KEYS[1], ARGV[1])
local mine = (owner == ARGV[2])
local free = (not owner) or (not deadline) or (tonumber(deadline) <= now)
if mine or free then
  redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  redis.call('PEXPIRE', KEYS[2], ttl * 2)
  return 1
end
return 0
`;

// Compare-and-delete: a connection that has already been superseded must not
// be able to release its successor's lease on its way out.
const RELEASE = `
if redis.call('HGET', KEYS[2], ARGV[1]) == ARGV[2] then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  return 1
end
return 0
`;

interface SessionCommands {
  sessionClaim(deadlines: string, owners: string, clientId: string, ownerId: string, ttlMs: number): Promise<string | null>;
  sessionTouch(deadlines: string, owners: string, clientId: string, ownerId: string, ttlMs: number): Promise<number>;
  sessionRelease(deadlines: string, owners: string, clientId: string, ownerId: string): Promise<number>;
}

export class SessionStore {
  #redis: Redis & SessionCommands;
  #ttlMs: number;

  constructor(redis: Redis, ttlMs: number) {
    redis.defineCommand('sessionClaim', { numberOfKeys: 2, lua: CLAIM });
    redis.defineCommand('sessionTouch', { numberOfKeys: 2, lua: TOUCH });
    redis.defineCommand('sessionRelease', { numberOfKeys: 2, lua: RELEASE });
    this.#redis = redis as Redis & SessionCommands;
    this.#ttlMs = ttlMs;
  }

  #keys(roomId: string): [string, string] {
    return [`strand:{${roomId}}:sessions:deadlines`, `strand:{${roomId}}:sessions:owners`];
  }

  /** Takes the lease unconditionally (newest wins) and returns the owner it
   * displaced, if that owner's lease was still live. */
  async claim(roomId: string, clientId: string, ownerId: string): Promise<string | null> {
    const [deadlines, owners] = this.#keys(roomId);
    return this.#redis.sessionClaim(deadlines, owners, clientId, ownerId, this.#ttlMs);
  }

  /** True if `ownerId` still holds (or can again take) the lease; false only
   * when a different, live owner holds it. */
  async touch(roomId: string, clientId: string, ownerId: string): Promise<boolean> {
    const [deadlines, owners] = this.#keys(roomId);
    return (await this.#redis.sessionTouch(deadlines, owners, clientId, ownerId, this.#ttlMs)) === 1;
  }

  async release(roomId: string, clientId: string, ownerId: string): Promise<void> {
    const [deadlines, owners] = this.#keys(roomId);
    await this.#redis.sessionRelease(deadlines, owners, clientId, ownerId);
  }
}

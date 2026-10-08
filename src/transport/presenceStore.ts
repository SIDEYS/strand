import type { Redis } from 'ioredis';
import type { PresenceValue } from '../presence/types.js';
import { MessageType, decode, encodePresenceBroadcast } from '../protocol/index.js';

export interface StoredPresence {
  clientId: string;
  timestamp: number;
  value: PresenceValue;
}

/**
 * Per-room presence liveness in Redis, with expiry decided by Redis's clock.
 *
 * Layout per room: a sorted set (clientId -> expiry deadline) and a hash
 * (clientId -> encoded entry). Both keys share a {roomId} hash tag so the
 * Lua scripts below stay single-slot under Redis Cluster. A key-per-client
 * with PEXPIRE would be simpler, but finding "everyone in this room" would
 * then need SCAN across the whole keyspace on every sync tick.
 *
 * Why Redis owns the clock: if each instance judged expiry from its own
 * clock, two instances could disagree about whether the same client is
 * still alive. The deadline is written and compared by Redis's TIME, so
 * there is one answer.
 *
 * This store is the *liveness* source of truth (is anyone still refreshing
 * this entry?). Ordering between competing values is still the LWW set's
 * job, using the entry's own timestamp.
 */
const UPSERT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local ttl = tonumber(ARGV[3])
redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
-- Let a room nobody refreshes anymore disappear entirely instead of
-- leaving two empty-but-permanent keys per room ever used.
redis.call('PEXPIRE', KEYS[1], ttl * 2)
redis.call('PEXPIRE', KEYS[2], ttl * 2)
return 1
`;

const REMOVE = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`;

// unpack() is capped at a few thousand arguments in Lua; a single room's
// presence is nowhere near that, so no chunking.
const LIST = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
if #expired > 0 then
  redis.call('ZREM', KEYS[1], unpack(expired))
  redis.call('HDEL', KEYS[2], unpack(expired))
end
local live = redis.call('ZRANGE', KEYS[1], 0, -1)
if #live == 0 then return {} end
return redis.call('HMGET', KEYS[2], unpack(live))
`;

interface PresenceCommands {
  presenceUpsert(zset: string, hash: string, clientId: string, data: Buffer, ttlMs: number): Promise<number>;
  presenceRemove(zset: string, hash: string, clientId: string): Promise<number>;
  presenceListBuffer(zset: string, hash: string): Promise<Array<Buffer | null>>;
}

export class PresenceStore {
  #redis: Redis & PresenceCommands;
  #ttlMs: number;

  constructor(redis: Redis, ttlMs: number) {
    redis.defineCommand('presenceUpsert', { numberOfKeys: 2, lua: UPSERT });
    redis.defineCommand('presenceRemove', { numberOfKeys: 2, lua: REMOVE });
    redis.defineCommand('presenceList', { numberOfKeys: 2, lua: LIST });
    this.#redis = redis as Redis & PresenceCommands;
    this.#ttlMs = ttlMs;
  }

  #keys(roomId: string): [string, string] {
    return [`strand:{${roomId}}:presence:deadlines`, `strand:{${roomId}}:presence:entries`];
  }

  async upsert(roomId: string, entry: StoredPresence): Promise<void> {
    const [zset, hash] = this.#keys(roomId);
    const data = Buffer.from(encodePresenceBroadcast(entry.clientId, entry.timestamp, entry.value));
    await this.#redis.presenceUpsert(zset, hash, entry.clientId, data, this.#ttlMs);
  }

  async remove(roomId: string, clientId: string): Promise<void> {
    const [zset, hash] = this.#keys(roomId);
    await this.#redis.presenceRemove(zset, hash, clientId);
  }

  /** Everyone whose entry has not expired. Also prunes expired entries as a
   * side effect, so the keys stay bounded without a separate janitor. */
  async list(roomId: string): Promise<StoredPresence[]> {
    const [zset, hash] = this.#keys(roomId);
    const blobs = await this.#redis.presenceListBuffer(zset, hash);
    const out: StoredPresence[] = [];
    for (const blob of blobs) {
      if (!blob) continue;
      const msg = decode(new Uint8Array(blob));
      if (msg.type === MessageType.PresenceBroadcast) {
        out.push({ clientId: msg.clientId, timestamp: msg.timestamp, value: msg.value });
      }
    }
    return out;
  }
}

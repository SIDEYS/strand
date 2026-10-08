import { Redis } from 'ioredis';
import type { Logger } from 'pino';

/**
 * The only thing replication needs from a message transport. Delivery is
 * explicitly best-effort: implementations may drop, delay, or duplicate
 * messages, and the Replicator is built so that none of that can cause
 * permanent divergence. Nothing here should ever be promoted to "reliable".
 */
export interface FanoutBus {
  /** Resolves to how many subscribers the transport reports reaching,
   * counting this instance's own subscription if it has one. */
  publish(channel: string, bytes: Uint8Array): Promise<number>;
  subscribe(channel: string, handler: (bytes: Uint8Array) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
  /** Drops connections with no cleanup, as a killed process would. */
  crash(): void;
}

export async function connectRedis(url: string, options: { failFast: boolean }): Promise<Redis> {
  const redis = new Redis(url, {
    // With the default offline queue, commands issued while Redis is
    // unreachable pile up in memory and then all fire on reconnect: a
    // publish storm of stale updates, from an instance that was already
    // behind. Failing fast instead turns an outage into dropped messages,
    // which reconciliation is designed to absorb anyway.
    enableOfflineQueue: !options.failFast,
    maxRetriesPerRequest: options.failFast ? 0 : null,
    lazyConnect: true,
  });
  await redis.connect();
  return redis;
}

/** Redis pub/sub. At-most-once: a subscriber that is disconnected, or too
 * slow and hits its client-output-buffer-limit, silently misses messages. */
export class RedisBus implements FanoutBus {
  #pub: Redis;
  #sub: Redis;
  #handlers = new Map<string, (bytes: Uint8Array) => void>();
  #logger: Logger;

  constructor(pub: Redis, sub: Redis, logger: Logger) {
    this.#pub = pub;
    this.#sub = sub;
    this.#logger = logger;
    this.#sub.on('messageBuffer', (channel: Buffer, message: Buffer) => {
      const handler = this.#handlers.get(channel.toString());
      if (!handler) return;
      try {
        handler(message);
      } catch (err) {
        this.#logger.error({ err, channel: channel.toString() }, 'fan-out handler threw');
      }
    });
    this.#sub.on('error', (err) => this.#logger.warn({ err }, 'redis subscriber error'));
    this.#pub.on('error', (err) => this.#logger.warn({ err }, 'redis publisher error'));
  }

  async publish(channel: string, bytes: Uint8Array): Promise<number> {
    return this.#pub.publish(channel, Buffer.from(bytes));
  }

  async subscribe(channel: string, handler: (bytes: Uint8Array) => void): Promise<void> {
    this.#handlers.set(channel, handler);
    await this.#sub.subscribe(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.#handlers.delete(channel);
    await this.#sub.unsubscribe(channel);
  }

  async close(): Promise<void> {
    this.#handlers.clear();
    await Promise.allSettled([this.#pub.quit(), this.#sub.quit()]);
    this.#pub.disconnect();
    this.#sub.disconnect();
  }

  crash(): void {
    this.#handlers.clear();
    this.#pub.disconnect();
    this.#sub.disconnect();
  }
}

import { randomUUID } from 'node:crypto';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`invalid integer for ${name}: ${raw}`);
  return parsed;
}

export interface Config {
  host: string;
  port: number;
  /** Unique per running process. Stamped on every fan-out message so an
   * instance can recognise and drop its own. */
  instanceId: string;
  /** When unset the gateway runs standalone, with no cross-instance
   * fan-out; one instance behaves exactly as in Phases 1-2. */
  redisUrl: string | undefined;
  /** How often each instance announces its state per room so peers can
   * notice and repair anything fan-out dropped. This is the upper bound on
   * how long divergence can persist once the network is healthy again. */
  reconcileIntervalMs: number;
  /** How long a joining instance waits for peers to answer its first
   * reconciliation before serving clients from whatever it has. */
  joinSyncTimeoutMs: number;
  /** Presence entries vanish this long after their last refresh. Refreshed
   * on every heartbeat pong, so it must comfortably exceed
   * heartbeatIntervalMs or live clients would flicker out. */
  presenceTtlMs: number;
  /** How often each connection is pinged. */
  heartbeatIntervalMs: number;
  /** Consecutive missed pongs before a connection is presumed dead. */
  heartbeatMaxMissedPongs: number;
  /** Outbound send-queue threshold, in buffered bytes, before a client is
   * disconnected for backpressure rather than buffered indefinitely. */
  backpressureThresholdBytes: number;
  /** Inbound frame size cap; see protocol/types.ts for the rationale. */
  maxInboundMessageBytes: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    host: env.HOST ?? '0.0.0.0',
    port: envInt('PORT', 8080),
    instanceId: env.INSTANCE_ID || randomUUID(),
    redisUrl: env.REDIS_URL || undefined,
    reconcileIntervalMs: envInt('RECONCILE_INTERVAL_MS', 5000),
    joinSyncTimeoutMs: envInt('JOIN_SYNC_TIMEOUT_MS', 500),
    presenceTtlMs: envInt('PRESENCE_TTL_MS', 45_000),
    heartbeatIntervalMs: envInt('HEARTBEAT_INTERVAL_MS', 15_000),
    heartbeatMaxMissedPongs: envInt('HEARTBEAT_MAX_MISSED_PONGS', 2),
    backpressureThresholdBytes: envInt('BACKPRESSURE_THRESHOLD_BYTES', 1024 * 1024),
    maxInboundMessageBytes: envInt('MAX_INBOUND_MESSAGE_BYTES', 65536),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
  if (config.presenceTtlMs < config.heartbeatIntervalMs * 2) {
    throw new Error(
      `PRESENCE_TTL_MS (${config.presenceTtlMs}) must be at least twice HEARTBEAT_INTERVAL_MS (${config.heartbeatIntervalMs}), or live clients will expire between refreshes`,
    );
  }
  return config;
}

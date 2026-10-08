import { randomUUID } from 'node:crypto';

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
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
  /** HMAC key for resume tokens. Every instance in a deployment must share
   * it, since any instance may be asked to honour a token another issued. */
  resumeSecret: string;
  /** True when no RESUME_SECRET was supplied and a throwaway one was
   * generated, which only makes sense for a single standalone process. */
  resumeSecretIsEphemeral: boolean;
  /** How long a resume token stays valid. Short on purpose: it only has to
   * outlast a reconnect, and it cannot be revoked once issued. */
  resumeTtlMs: number;
  /** When unset nothing is persisted: rooms live only in memory, as in
   * earlier phases. */
  databaseUrl: string | undefined;
  /** How often buffered ops are written. Bounds the window in which a crash
   * of the originating instance loses ops from the log. */
  persistFlushIntervalMs: number;
  /** Snapshot after this many changes since the last... */
  snapshotEveryOps: number;
  /** ...or this long after the first unsnapshotted change. */
  snapshotIntervalMs: number;
  /** Compaction keeps ops tagged within this many snapshot versions of the
   * newest. Larger is safer against slow-to-snapshot instances and costs
   * a longer log to replay on recovery. */
  opRetentionVersions: number;
  /** Cap on one room's unwritten op buffer before it is dropped in favour of
   * a forced snapshot. */
  maxPendingOps: number;
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

const MIN_SECRET_CHARS = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const redisUrl = env.REDIS_URL || undefined;
  const suppliedSecret = env.RESUME_SECRET || undefined;
  if (suppliedSecret !== undefined && suppliedSecret.length < MIN_SECRET_CHARS) {
    throw new Error(`RESUME_SECRET must be at least ${MIN_SECRET_CHARS} characters (try: openssl rand -base64 32)`);
  }
  if (redisUrl !== undefined && suppliedSecret === undefined) {
    // A random per-process secret would make every instance reject tokens
    // issued by the others, which only shows up as resumes quietly failing
    // once a load balancer sends a client to a different instance.
    throw new Error('RESUME_SECRET is required when REDIS_URL is set: all instances must share it');
  }
  const config: Config = {
    host: env.HOST ?? '0.0.0.0',
    port: envInt(env, 'PORT', 8080),
    instanceId: env.INSTANCE_ID || randomUUID(),
    redisUrl,
    resumeSecret: suppliedSecret ?? randomUUID() + randomUUID(),
    resumeSecretIsEphemeral: suppliedSecret === undefined,
    resumeTtlMs: envInt(env, 'RESUME_TTL_MS', 5 * 60 * 1000),
    databaseUrl: env.DATABASE_URL || undefined,
    persistFlushIntervalMs: envInt(env, 'PERSIST_FLUSH_INTERVAL_MS', 250),
    snapshotEveryOps: envInt(env, 'SNAPSHOT_EVERY_OPS', 500),
    snapshotIntervalMs: envInt(env, 'SNAPSHOT_INTERVAL_MS', 30_000),
    opRetentionVersions: envInt(env, 'OP_RETENTION_VERSIONS', 4),
    maxPendingOps: envInt(env, 'MAX_PENDING_OPS', 2000),
    reconcileIntervalMs: envInt(env, 'RECONCILE_INTERVAL_MS', 5000),
    joinSyncTimeoutMs: envInt(env, 'JOIN_SYNC_TIMEOUT_MS', 500),
    presenceTtlMs: envInt(env, 'PRESENCE_TTL_MS', 45_000),
    heartbeatIntervalMs: envInt(env, 'HEARTBEAT_INTERVAL_MS', 15_000),
    heartbeatMaxMissedPongs: envInt(env, 'HEARTBEAT_MAX_MISSED_PONGS', 2),
    backpressureThresholdBytes: envInt(env, 'BACKPRESSURE_THRESHOLD_BYTES', 1024 * 1024),
    maxInboundMessageBytes: envInt(env, 'MAX_INBOUND_MESSAGE_BYTES', 65536),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
  if (config.presenceTtlMs < config.heartbeatIntervalMs * 2) {
    throw new Error(
      `PRESENCE_TTL_MS (${config.presenceTtlMs}) must be at least twice HEARTBEAT_INTERVAL_MS (${config.heartbeatIntervalMs}), or live clients will expire between refreshes`,
    );
  }
  return config;
}

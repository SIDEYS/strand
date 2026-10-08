import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import pino from 'pino';
import { loadConfig } from './config.js';
import { buildApiServer } from './api/server.js';
import { GatewayServer } from './gateway/server.js';
import { DocumentStore } from './persistence/documentStore.js';
import { Persistence } from './persistence/persistence.js';
import { RedisBus, connectRedis } from './transport/bus.js';
import { HybridClock } from './transport/clock.js';
import { PresenceStore } from './transport/presenceStore.js';
import { Replicator } from './transport/replicator.js';
import { SessionStore } from './transport/sessionStore.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel, base: { instanceId: config.instanceId } });

if (config.resumeSecretIsEphemeral) {
  logger.warn('RESUME_SECRET not set: using a throwaway secret, so resume tokens will not survive a restart');
}

const staticRoot = existsSync(path.join(config.webRoot, 'index.html')) ? path.resolve(config.webRoot) : undefined;
if (staticRoot === undefined) logger.warn({ webRoot: config.webRoot }, 'no built web client found; serving the API only (run: npm run build:web)');
const api = buildApiServer(logger, staticRoot ? { staticRoot } : {});
await api.ready();

const clock = new HybridClock();
let fanout: Replicator | undefined;
let dataRedis: Awaited<ReturnType<typeof connectRedis>> | undefined;

if (config.redisUrl) {
  // Three connections on purpose: a connection in subscriber mode can't
  // issue other commands, and the publisher and data paths both fail fast
  // when Redis is down rather than queueing (see connectRedis).
  const pub = await connectRedis(config.redisUrl, { failFast: true, logger });
  const sub = await connectRedis(config.redisUrl, { failFast: false, logger });
  dataRedis = await connectRedis(config.redisUrl, { failFast: true, logger });
  fanout = new Replicator({
    instanceId: config.instanceId,
    bus: new RedisBus(pub, sub, logger),
    store: new PresenceStore(dataRedis, config.presenceTtlMs),
    sessions: new SessionStore(dataRedis, config.presenceTtlMs),
    clock,
    logger,
    reconcileIntervalMs: config.reconcileIntervalMs,
    joinSyncTimeoutMs: config.joinSyncTimeoutMs,
  });
} else {
  logger.warn('REDIS_URL not set: running standalone, rooms are not shared with other instances');
}

let pool: pg.Pool | undefined;
let persistence: Persistence | undefined;
if (config.databaseUrl) {
  // Timeouts so a hung database fails queries (which the persistence layer
  // retries or tolerates) instead of holding them open indefinitely.
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    query_timeout: 15_000,
  });
  pool.on('error', (err) => logger.warn({ err }, 'postgres pool error'));
  persistence = new Persistence({
    store: new DocumentStore(pool),
    instanceId: config.instanceId,
    logger,
    flushIntervalMs: config.persistFlushIntervalMs,
    snapshotEveryOps: config.snapshotEveryOps,
    snapshotIntervalMs: config.snapshotIntervalMs,
    retentionVersions: config.opRetentionVersions,
    maxPendingOps: config.maxPendingOps,
    maxPendingBytes: 8 * 1024 * 1024,
  });
} else {
  logger.warn('DATABASE_URL not set: documents are not persisted and are lost when every instance of a room stops');
}

const gateway = new GatewayServer({
  server: api.server,
  config,
  logger,
  clock,
  ...(fanout ? { fanout } : {}),
  ...(persistence ? { persistence } : {}),
});

await api.listen({ host: config.host, port: config.port });
logger.info({ host: config.host, port: config.port, fanout: fanout !== undefined, persistence: persistence !== undefined }, 'strand gateway listening');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  await gateway.shutdown();
  dataRedis?.disconnect();
  await pool?.end();
  await api.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

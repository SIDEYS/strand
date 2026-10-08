import pino from 'pino';
import { loadConfig } from './config.js';
import { buildApiServer } from './api/server.js';
import { GatewayServer } from './gateway/server.js';
import { RedisBus, connectRedis } from './transport/bus.js';
import { HybridClock } from './transport/clock.js';
import { PresenceStore } from './transport/presenceStore.js';
import { Replicator } from './transport/replicator.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel, base: { instanceId: config.instanceId } });

if (config.resumeSecretIsEphemeral) {
  logger.warn('RESUME_SECRET not set: using a throwaway secret, so resume tokens will not survive a restart');
}

const api = buildApiServer(logger);
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
    clock,
    logger,
    reconcileIntervalMs: config.reconcileIntervalMs,
    joinSyncTimeoutMs: config.joinSyncTimeoutMs,
  });
} else {
  logger.warn('REDIS_URL not set: running standalone, rooms are not shared with other instances');
}

const gateway = new GatewayServer({ server: api.server, config, logger, clock, ...(fanout ? { fanout } : {}) });

await api.listen({ host: config.host, port: config.port });
logger.info({ host: config.host, port: config.port, fanout: fanout !== undefined }, 'strand gateway listening');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  await gateway.shutdown();
  dataRedis?.disconnect();
  await api.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

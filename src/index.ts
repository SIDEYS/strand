import pino from 'pino';
import { loadConfig } from './config.js';
import { buildApiServer } from './api/server.js';
import { GatewayServer } from './gateway/server.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });

const api = buildApiServer(logger);
await api.ready();

const gateway = new GatewayServer({ server: api.server, config, logger });

await api.listen({ host: config.host, port: config.port });
logger.info({ host: config.host, port: config.port }, 'strand gateway listening');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  await gateway.shutdown();
  await api.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

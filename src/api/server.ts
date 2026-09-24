import Fastify from 'fastify';
import type { Logger } from 'pino';

export function buildApiServer(logger: Logger) {
  const app = Fastify({ loggerInstance: logger });

  // Deliberately just a 200. Phase 7 splits this into /healthz (process
  // alive) vs /readyz (Redis/Postgres reachable) — a readiness check that
  // always returns healthy without actually checking anything would be
  // worse than no check at all, so it isn't added until it can be real.
  app.get('/healthz', () => ({ status: 'ok' }));

  return app;
}

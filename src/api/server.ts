import { createReadStream } from 'node:fs';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import { resolveStaticFile } from './static.js';

export interface ApiOptions {
  /** Directory of the built web client. Omit to serve only the API. */
  staticRoot?: string;
}

export function buildApiServer(logger: Logger, options: ApiOptions = {}) {
  const app = Fastify({ loggerInstance: logger });

  // Deliberately just a 200. Phase 7 splits this into /healthz (process
  // alive) vs /readyz (Redis/Postgres reachable) — a readiness check that
  // always returns healthy without actually checking anything would be
  // worse than no check at all, so it isn't added until it can be real.
  app.get('/healthz', () => ({ status: 'ok' }));

  const { staticRoot } = options;
  if (staticRoot !== undefined) {
    app.get('/*', async (request, reply) => {
      const urlPath = request.url.split('?')[0] ?? '/';
      const found = await resolveStaticFile(staticRoot, urlPath);
      if (found === null) return reply.code(404).type('text/plain').send('Not found');
      // The HTML shell must always be revalidated so a deploy is picked up;
      // content-hashed assets can be cached forever.
      reply.header('cache-control', found.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      return reply.type(found.contentType).send(createReadStream(found.file));
    });
  }

  return app;
}

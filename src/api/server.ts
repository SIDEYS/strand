import { createReadStream } from 'node:fs';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import type { PromMetrics } from '../metrics/prom.js';
import type { ReadinessReport } from './readiness.js';
import { resolveStaticFile } from './static.js';

export interface ApiOptions {
  /** Directory of the built web client. Omit to serve only the API. */
  staticRoot?: string;
  /** Serves GET /metrics. */
  metrics?: PromMetrics;
  /** Backs GET /readyz. Omit when there are no dependencies to check. */
  readiness?: () => Promise<ReadinessReport>;
  /** Echoed as X-Strand-Instance on every response. */
  instanceId?: string;
}

export function buildApiServer(logger: Logger, options: ApiOptions = {}) {
  const app = Fastify({ loggerInstance: logger });

  const { instanceId } = options;
  if (instanceId !== undefined) {
    app.addHook('onSend', (_request, reply, payload, done) => {
      reply.header('x-strand-instance', instanceId);
      done(null, payload);
    });
  }

  // Liveness: is the process up and its event loop answering. It checks
  // nothing else on purpose. If this failed whenever Redis did, an
  // orchestrator would restart healthy instances during a Redis outage and
  // drop every socket they were still serving. See /readyz for the other
  // question.
  app.get('/healthz', () => ({ status: 'ok' }));

  // Readiness: should this instance be given NEW traffic? Not ready (503) when
  // a configured dependency is unreachable. The process stays up and keeps
  // serving existing connections.
  app.get('/readyz', async (_request, reply) => {
    const report = options.readiness
      ? await options.readiness()
      : { ready: true, checks: { redis: 'disabled', postgres: 'disabled' } };
    return reply.code(report.ready ? 200 : 503).send({ status: report.ready ? 'ready' : 'not_ready', ...report.checks });
  });

  const { metrics } = options;
  if (metrics !== undefined) {
    app.get('/metrics', async (_request, reply) => reply.type(metrics.contentType).send(await metrics.render()));
  }

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

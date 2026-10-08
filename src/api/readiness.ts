export type CheckResult = 'ok' | 'down' | 'disabled';

export interface ReadinessReport {
  ready: boolean;
  checks: { redis: CheckResult; postgres: CheckResult };
}

export interface ReadinessProbes {
  /** Omit for a dependency this instance is not configured to use. */
  redis?: () => Promise<unknown>;
  postgres?: () => Promise<unknown>;
  /** A probe that takes longer than this counts as down. Default 1000. */
  timeoutMs?: number;
  /** How long a result is reused. Default 1000. */
  cacheMs?: number;
  now?: () => number;
}

async function run(probe: (() => Promise<unknown>) | undefined, timeoutMs: number): Promise<CheckResult> {
  if (probe === undefined) return 'disabled';
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timed out')), timeoutMs);
      }),
    ]);
    return 'ok';
  } catch {
    // Anything at all (a rejection, a timeout, a thrown error) means "not
    // ready". It must never escape: a failing dependency has to produce a 503,
    // not an unhandled rejection that takes the process down.
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Readiness: can this instance usefully take NEW traffic right now?
 *
 * That is deliberately a different question from liveness (/healthz, "is the
 * process running"). A Redis outage makes an instance not ready, so a load
 * balancer stops sending it new connections, but it must not make the process
 * unhealthy, or an orchestrator would restart a perfectly good instance that is
 * still serving its existing sockets. The server's design is to degrade, not
 * refuse (see ADR 0003), and readiness is the signal that matches: keep what we
 * have, stop accepting more until the dependency is back.
 *
 * Probes run in parallel, each bounded by a timeout, and the result is cached
 * briefly with concurrent callers sharing one run, so a load balancer's checks
 * cannot turn into load on Redis and Postgres.
 */
export function createReadiness(probes: ReadinessProbes): () => Promise<ReadinessReport> {
  const timeoutMs = probes.timeoutMs ?? 1000;
  const cacheMs = probes.cacheMs ?? 1000;
  const now = probes.now ?? (() => Date.now());
  let cached: { at: number; report: ReadinessReport } | null = null;
  let inFlight: Promise<ReadinessReport> | null = null;

  return async () => {
    if (cached !== null && now() - cached.at < cacheMs) return cached.report;
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      const [redis, postgres] = await Promise.all([run(probes.redis, timeoutMs), run(probes.postgres, timeoutMs)]);
      const report: ReadinessReport = { ready: redis !== 'down' && postgres !== 'down', checks: { redis, postgres } };
      cached = { at: now(), report };
      return report;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

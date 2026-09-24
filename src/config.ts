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
  /** How often the server pings each connection. */
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
  return {
    host: env.HOST ?? '0.0.0.0',
    port: envInt('PORT', 8080),
    heartbeatIntervalMs: envInt('HEARTBEAT_INTERVAL_MS', 15000),
    heartbeatMaxMissedPongs: envInt('HEARTBEAT_MAX_MISSED_PONGS', 2),
    backpressureThresholdBytes: envInt('BACKPRESSURE_THRESHOLD_BYTES', 1024 * 1024),
    maxInboundMessageBytes: envInt('MAX_INBOUND_MESSAGE_BYTES', 65536),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

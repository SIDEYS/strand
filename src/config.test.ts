import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const SECRET = 'x'.repeat(32);

describe('loadConfig', () => {
  it('runs standalone with a throwaway resume secret when neither Redis nor a secret is configured', () => {
    const config = loadConfig({});
    expect(config.redisUrl).toBeUndefined();
    expect(config.resumeSecretIsEphemeral).toBe(true);
    expect(config.resumeSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('refuses to start with Redis but no shared resume secret', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://localhost:6379' })).toThrow(/RESUME_SECRET is required/);
  });

  it('accepts Redis with a shared secret', () => {
    const config = loadConfig({ REDIS_URL: 'redis://localhost:6379', RESUME_SECRET: SECRET });
    expect(config.resumeSecretIsEphemeral).toBe(false);
    expect(config.resumeSecret).toBe(SECRET);
  });

  it('rejects a short resume secret', () => {
    expect(() => loadConfig({ RESUME_SECRET: 'too-short' })).toThrow(/at least 32/);
  });

  it('rejects a presence TTL that would expire live clients between heartbeats', () => {
    expect(() => loadConfig({ PRESENCE_TTL_MS: '20000', HEARTBEAT_INTERVAL_MS: '15000' })).toThrow(/PRESENCE_TTL_MS/);
  });
});

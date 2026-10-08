import { GenericContainer, type StartedTestContainer } from 'testcontainers';

export interface TestRedis {
  url: string;
  container: StartedTestContainer;
  stop(): Promise<void>;
}

/** A real Redis, not a mock: the behaviours under test (pub/sub loss,
 * Lua scripts, server-side TIME and expiry) are exactly what a fake would
 * get wrong. */
export async function startTestRedis(): Promise<TestRedis> {
  // Default port-open wait on purpose: Wait.forLogMessage took ~60s per
  // container here, and Redis accepts connections as soon as the port is up.
  const container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    container,
    stop: async () => {
      await container.stop();
    },
  };
}

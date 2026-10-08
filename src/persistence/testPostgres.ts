import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

export interface TestPostgres {
  url: string;
  container: StartedTestContainer;
  pool: pg.Pool;
  /** Empties every table, keeping the schema. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Applies the repo's real migrations, so tests run against the schema that
 * production would, not a hand-copied one. */
export async function migrate(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: () => undefined,
  });
}

/** A real Postgres in a container. The port opens before the server accepts
 * queries, so readiness is established by actually querying, not by
 * watching logs (which took about a minute per container to match). */
export async function startTestPostgres(): Promise<TestPostgres> {
  const container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'strand', POSTGRES_PASSWORD: 'strand', POSTGRES_DB: 'strand' })
    .withExposedPorts(5432)
    .start();
  const url = `postgres://strand:strand@${container.getHost()}:${container.getMappedPort(5432)}/strand`;

  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = new pg.Client({ connectionString: url });
    try {
      await probe.connect();
      await probe.query('select 1');
      await probe.end();
      break;
    } catch (err) {
      await probe.end().catch(() => undefined);
      if (Date.now() > deadline) throw new Error(`postgres did not become ready: ${String(err)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    url,
    container,
    pool,
    async reset() {
      await pool.query('TRUNCATE document_ops, documents RESTART IDENTITY CASCADE');
    },
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}

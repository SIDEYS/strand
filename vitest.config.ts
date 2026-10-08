import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `*.int.test.ts` files need Docker (they start real Redis and Postgres
    // with testcontainers). Everything else is fast and self-contained, so CI
    // runs the two groups as separate jobs: npm run test:unit, test:integration.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'web/src/**/*.test.ts', 'loadtest/**/*.test.mjs'],
          exclude: ['**/node_modules/**', '**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
        },
      },
    ],
  },
});

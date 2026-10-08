// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'web/**', 'coverage/**', 'loadtest/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The shared client core runs in the browser, under Node in integration
    // tests, and under a fake clock in unit tests. It stays portable by
    // receiving its socket, scheduler, and randomness instead of reaching for
    // them, and these rules make that a build failure rather than a
    // convention: reaching for any of them here is an error.
    files: ['src/client/**/*.ts'],
    ignores: ['src/client/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...[
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'queueMicrotask',
          'Date',
          'performance',
          'WebSocket',
          'window',
          'document',
          'navigator',
          'localStorage',
          'sessionStorage',
          'location',
          'console',
          'process',
          'Buffer',
        ].map((name) => ({ name, message: `Inject it instead: the client core must not touch the environment (${name}).` })),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Take `random` as an option so tests are deterministic.' },
        { object: 'globalThis', property: 'setTimeout', message: 'Use the injected scheduler.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'The client core must run in a browser: no Node built-ins.' },
            { group: ['react', 'react-dom', 'react/*'], message: 'The client core owns no UI framework.' },
          ],
        },
      ],
    },
  },
);

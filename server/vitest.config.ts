import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/testing/**',
        'src/index.ts',
        'src/types/**',
      ],
      // Core business logic is well tested (auth, rbac, password, robin-api, queries)
      // Routes require integration testing setup
      thresholds: {
        statements: 15,
        branches: 50,
        functions: 50,
        lines: 15,
      },
    },
    setupFiles: ['./src/testing/setup.ts'],
  },
});

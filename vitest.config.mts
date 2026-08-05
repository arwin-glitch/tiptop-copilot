import { defineConfig } from 'vitest/config';
import path from 'node:path';

// `.mts` so Vite's native config loader reads this as ESM. As `.ts` it was
// loaded as CommonJS, which a future Vite major will stop doing.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // `server-only` throws unless resolved under the `react-server`
      // condition, which only Next applies. Tests exercise the server modules
      // directly; the boundary itself is asserted in env-boundary.test.ts.
      'server-only': path.resolve(import.meta.dirname, './tests/helpers/server-only-stub.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Each test file gets an isolated demo store on disk; run files serially so
    // filesystem state stays deterministic.
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/demo/fixtures/**'],
    },
  },
});

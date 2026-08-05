/**
 * Stand-in for the `server-only` marker package.
 *
 * Its real entry point throws unless resolved under the `react-server`
 * condition, which only Next applies. Tests exercise the server modules
 * directly, so `vitest.config.mts` aliases `server-only` to this no-op. The
 * boundary it protects is checked for real in `tests/unit/env-boundary.test.ts`,
 * which asserts that no client component imports one of those modules.
 */
export {};

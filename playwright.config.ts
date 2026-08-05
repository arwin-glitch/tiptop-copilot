import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Wipes the file-backed demo store so every run starts from the fixtures.
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // `responsive.spec.ts` asserts the mobile layout and needs the touch
    // viewport, so it belongs to the mobile project alone.
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /responsive\.spec\.ts/,
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: {
    command: `npm run start:demo -- --port ${PORT}`,
    url: BASE_URL,
    timeout: 180_000,
    // Never reused: the server holds the demo store in memory, so reusing one
    // would defeat the reset in globalSetup and make the suite order-dependent.
    reuseExistingServer: false,
    env: {
      DEMO_MODE: 'true',
      NEXT_PUBLIC_DEMO_MODE: 'true',
      DEMO_DATA_DIR: '.demo-data/e2e',
      APP_ENCRYPTION_KEY: 'ZTJlMmUyZTJlMmUyZTJlMmUyZTJlMmUyZTJlMmUyZTJlMmUyZTJlMmU9',
      SESSION_SECRET: 'e2e-session-secret-not-a-production-value-000000',
    },
  },
});

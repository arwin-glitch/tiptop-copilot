/**
 * Global test setup.
 *
 * Tests run against the demo store and the deterministic offline model, so the
 * whole suite exercises the real services — sync, extraction, scoring,
 * citation validation, authorization — with no network and no credentials.
 *
 * The values below are test fixtures, not secrets: the encryption key is a
 * well-known 32-byte base64 string used only here, and no production value is
 * ever placed in this repository.
 */

process.env.DEMO_MODE = 'true';
process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
process.env.DEMO_DATA_DIR = '.demo-data/test';
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET = 'test-session-secret-not-a-production-value-0000';
process.env.APP_URL = 'http://localhost:3000';
process.env.RESEARCH_PROVIDER = 'none';
process.env.DAILY_AI_BUDGET_USD = '1000';
process.env.MAX_AI_REQUESTS_PER_USER_PER_HOUR = '10000';

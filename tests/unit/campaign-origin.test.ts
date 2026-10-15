import { afterEach, describe, expect, it } from 'vitest';
import { trackingOrigin } from '@/lib/campaigns/route-helpers';
import { resetEnvCache } from '@/lib/config/env';

/**
 * A real campaign never goes out with tracking links on a local address:
 * every pixel, link and unsubscribe in it would be broken for its recipients.
 * trackingOrigin gives null then, and the campaign service refuses any
 * campaign whose emails carry Copilot links (see the integration tests).
 */

const SAVED = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

function withEnv(values: Record<string, string>) {
  Object.assign(process.env, values);
  resetEnvCache();
}

describe('trackingOrigin', () => {
  it('is null for a local APP_URL outside demo mode', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3100', 'http://[::1]']) {
      withEnv({ DEMO_MODE: 'false', APP_URL: url });
      expect(trackingOrigin(), url).toBeNull();
    }
  });

  it('is the public address, and a local one in demo mode', () => {
    withEnv({ DEMO_MODE: 'false', APP_URL: 'https://copilot.example' });
    expect(trackingOrigin()).toBe('https://copilot.example');
    withEnv({ DEMO_MODE: 'false', APP_URL: 'https://localhost.example.com' });
    expect(trackingOrigin()).toBe('https://localhost.example.com');
    withEnv({ DEMO_MODE: 'true', APP_URL: 'http://localhost:3000' });
    expect(trackingOrigin()).toBe('http://localhost:3000');
  });
});

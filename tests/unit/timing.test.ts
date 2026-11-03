import { afterEach, describe, expect, it, vi } from 'vitest';
import { timed, timingEnabled } from '@/lib/util/timing';

describe('timed', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is silent and passes the result through when the flag is off', async () => {
    vi.stubEnv('KRAKEN_TIMING', '');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(timingEnabled()).toBe(false);
    await expect(timed('tasks', 'pull', async () => 42)).resolves.toBe(42);
    expect(info).not.toHaveBeenCalled();
  });

  it('logs one line per step with the flag on', async () => {
    vi.stubEnv('KRAKEN_TIMING', '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await expect(timed('today', 'briefings', async () => 'ok')).resolves.toBe('ok');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/^\[timing\] today briefings \d+ms$/);
  });

  it('still logs, and rethrows, when the step fails', async () => {
    vi.stubEnv('KRAKEN_TIMING', '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await expect(
      timed('deals', 'pull', async () => {
        throw new Error('slack down');
      }),
    ).rejects.toThrow('slack down');
    expect(info).toHaveBeenCalledTimes(1);
  });
});

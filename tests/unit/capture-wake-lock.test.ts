import { describe, expect, it } from 'vitest';
import { VisibilityWatch, WakeLockKeeper, wakeLockSupported } from '@/lib/capture/wake-lock';

/**
 * Keeping a phone recording (D-076, WS3): the screen wake lock is held while
 * recording, taken again when the page comes back, and released at the end;
 * time away is measured so the person is told what was missed.
 */

function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_type: string, l: () => void) => listeners.add(l),
    removeEventListener: (_type: string, l: () => void) => listeners.delete(l),
  };
  return {
    doc: doc as unknown as Pick<
      Document,
      'visibilityState' | 'addEventListener' | 'removeEventListener'
    >,
    set(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      for (const l of [...listeners]) l();
    },
    listeners,
  };
}

function fakeWakeLock() {
  const sentinels: { released: boolean; release: () => Promise<void>; onRelease?: () => void }[] =
    [];
  return {
    sentinels,
    wakeLock: {
      request: async () => {
        const s = {
          released: false,
          onRelease: undefined as (() => void) | undefined,
          release: async () => {
            s.released = true;
            s.onRelease?.();
          },
          addEventListener: (_t: 'release', l: () => void) => {
            s.onRelease = l;
          },
        };
        sentinels.push(s);
        return s;
      },
    },
  };
}

describe('the wake lock keeper', () => {
  it('holds the lock, takes it again when the page comes back, and lets go', async () => {
    const d = fakeDocument();
    const w = fakeWakeLock();
    const keeper = new WakeLockKeeper({ wakeLock: w.wakeLock, document: d.doc });
    expect(keeper.supported).toBe(true);
    expect(await keeper.hold()).toBe(true);
    expect(keeper.held).toBe(true);

    // The browser drops the lock when the page is hidden.
    d.set('hidden');
    await w.sentinels[0]!.release();
    expect(keeper.held).toBe(false);
    d.set('visible');
    await Promise.resolve();
    await Promise.resolve();
    expect(w.sentinels).toHaveLength(2);
    expect(keeper.held).toBe(true);

    await keeper.release();
    expect(keeper.held).toBe(false);
    expect(w.sentinels[1]!.released).toBe(true);
    expect(d.listeners.size).toBe(0);
  });

  it('does nothing where there is no wake lock', async () => {
    const keeper = new WakeLockKeeper({ wakeLock: null, document: fakeDocument().doc });
    expect(keeper.supported).toBe(false);
    expect(await keeper.hold()).toBe(false);
    expect(wakeLockSupported({})).toBe(false);
  });

  it('survives a refusal (battery saver)', async () => {
    const keeper = new WakeLockKeeper({
      wakeLock: { request: async () => Promise.reject(new Error('NotAllowedError')) },
      document: fakeDocument().doc,
    });
    expect(await keeper.hold()).toBe(false);
  });
});

describe('the visibility watch', () => {
  it('reports how long the page was away', () => {
    const d = fakeDocument();
    let now = 1000;
    const away: number[] = [];
    let hidden = 0;
    const watch = new VisibilityWatch(
      () => (hidden += 1),
      (ms) => away.push(ms),
      d.doc,
      () => now,
    );
    watch.start();
    d.set('hidden');
    now += 83_000;
    d.set('visible');
    expect(hidden).toBe(1);
    expect(away).toEqual([83_000]);
    watch.stop();
    d.set('hidden');
    expect(hidden).toBe(1);
  });
});

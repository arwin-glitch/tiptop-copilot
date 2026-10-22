/**
 * Keeping a phone recording (D-076). On an iPhone the Home Screen app records
 * only while it is on screen: the microphone goes silent when the screen
 * locks or the app goes to the background (WebKit bug 226620). So while a
 * recording runs, the recorder holds a Screen Wake Lock (Home Screen apps
 * from iOS 18.4, Chrome everywhere), takes it again whenever the page comes
 * back (the browser drops it when the page is hidden), and notes how long
 * the page was away so the person is told what was missed.
 */

interface WakeLockSentinelLike {
  release(): Promise<void>;
  readonly released?: boolean;
  addEventListener?(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface WakeLockEnv {
  wakeLock?: WakeLockLike | null;
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | null;
}

function defaultEnv(): WakeLockEnv {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return {};
  const nav = navigator as Navigator & { wakeLock?: WakeLockLike };
  return { wakeLock: nav.wakeLock ?? null, document };
}

export function wakeLockSupported(env: WakeLockEnv = defaultEnv()): boolean {
  return Boolean(env.wakeLock);
}

export class WakeLockKeeper {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  private readonly env: WakeLockEnv;
  private readonly onVisibility = () => {
    if (this.wanted && this.env.document?.visibilityState === 'visible') void this.acquire();
  };

  constructor(env?: WakeLockEnv) {
    this.env = env ?? defaultEnv();
  }

  get supported(): boolean {
    return Boolean(this.env.wakeLock);
  }

  get held(): boolean {
    return Boolean(this.sentinel && !this.sentinel.released);
  }

  async hold(): Promise<boolean> {
    if (!this.wanted) {
      this.wanted = true;
      this.env.document?.addEventListener('visibilitychange', this.onVisibility);
    }
    return this.acquire();
  }

  private async acquire(): Promise<boolean> {
    const wakeLock = this.env.wakeLock;
    if (!wakeLock || this.held) return this.held;
    if (this.env.document && this.env.document.visibilityState !== 'visible') return false;
    try {
      const sentinel = await wakeLock.request('screen');
      if (!this.wanted) {
        await sentinel.release().catch(() => undefined);
        return false;
      }
      this.sentinel = sentinel;
      sentinel.addEventListener?.('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null;
      });
      return true;
    } catch {
      // Refused (battery saver, not visible): the "keep this screen open" banner still shows.
      return false;
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    this.env.document?.removeEventListener('visibilitychange', this.onVisibility);
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel && !sentinel.released) await sentinel.release().catch(() => undefined);
  }
}

/**
 * Notices when the page goes away and comes back while recording, and
 * reports how long it was away. On a phone the microphone heard nothing in
 * that time; the recorder says so instead of leaving a silent hole.
 */
export class VisibilityWatch {
  private hiddenAt: number | null = null;
  private readonly doc: WakeLockEnv['document'];
  private readonly handler = () => {
    if (!this.doc) return;
    if (this.doc.visibilityState === 'hidden') {
      this.hiddenAt = this.now();
      this.onHidden();
    } else if (this.hiddenAt !== null) {
      const away = this.now() - this.hiddenAt;
      this.hiddenAt = null;
      this.onVisible(away);
    }
  };

  constructor(
    private readonly onHidden: () => void,
    private readonly onVisible: (awayMs: number) => void,
    doc?: WakeLockEnv['document'],
    private readonly now: () => number = () => Date.now(),
  ) {
    this.doc = doc ?? (typeof document === 'undefined' ? null : document);
  }

  start(): void {
    this.doc?.addEventListener('visibilitychange', this.handler);
  }

  stop(): void {
    this.doc?.removeEventListener('visibilitychange', this.handler);
    this.hiddenAt = null;
  }
}

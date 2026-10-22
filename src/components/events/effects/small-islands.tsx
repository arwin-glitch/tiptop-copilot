'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ENTRANCE_CAP_MS } from '@/lib/events/theme/motion';
import { useInView, useLiveMotionScale, type IslandMotion } from './motion-runtime';

/** Small client islands the block views mount: count-up numbers, a "your time" hint, click-to-load embeds. */

/**
 * A number that counts up once when it scrolls into view. The server renders
 * the final value; non-numeric values ("Q3", "2.36x") count their numeric
 * part and keep the rest.
 */
export function CountUp({ value, motion }: { value: string; motion: IslandMotion }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, '0px');
  const scale = useLiveMotionScale(motion);
  const [shown, setShown] = useState(value);
  const played = useRef(false);

  useEffect(() => {
    if (!inView || played.current || scale === 0) return;
    const m = /^(\D*)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(value);
    if (!m) return;
    played.current = true;
    const [, pre = '', num = '0', post = ''] = m;
    const target = Number(num.replace(/,/g, ''));
    const decimals = num.includes('.') ? (num.split('.')[1]?.length ?? 0) : 0;
    const grouped = num.includes(',');
    const start = performance.now();
    const duration = ENTRANCE_CAP_MS * 2;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - p) ** 3;
      const current = target * eased;
      const text = grouped
        ? current.toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })
        : current.toFixed(decimals);
      setShown(`${pre}${text}${post}`);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setShown(value);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      // Interrupted (re-render, Pause): land on the real number, never mid-count.
      cancelAnimationFrame(raf);
      setShown(value);
    };
  }, [inView, scale, value]);

  return (
    <span ref={ref}>
      {/* Screen readers get the real number, never the digits mid-count. */}
      <span className="ev-sr">{value}</span>
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}

const noSubscribe = () => () => {};
const viewerZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

/** "8 PM your time" when the viewer's zone differs from the venue's (client only). */
function localTimeText(startsAt: string, mine: string, venueZone: string): string | null {
  try {
    const d = new Date(startsAt);
    const fmt = (tz: string) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: '2-digit',
        weekday: 'short',
      }).format(d);
    const theirs = fmt(venueZone);
    const local = fmt(mine);
    return local === theirs ? null : `${local.replace(':00', '')} your time`;
  } catch {
    return null;
  }
}

export function LocalTimeHint({
  startsAt,
  venueZone,
}: {
  startsAt: string | null;
  venueZone: string;
}) {
  const mine = useSyncExternalStore(noSubscribe, viewerZone, () => null);
  const text =
    startsAt && mine && mine !== venueZone ? localTimeText(startsAt, mine, venueZone) : null;
  if (!text) return null;
  return <span className="ev-local-time">{text}</span>;
}

/**
 * An allowlisted embed (YouTube via youtube-nocookie, Vimeo, Loom, Spotify,
 * Google Maps) that loads only when the guest taps it. The URL is built here
 * from a validated id; no other iframe exists on event pages (CSP frame-src).
 */
export function ClickToLoadFrame({
  src,
  title,
  label,
  aspect = '16 / 9',
}: {
  src: string;
  title: string;
  label: string;
  aspect?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  if (loaded) {
    return (
      <div className="ev-embed" style={{ aspectRatio: aspect }}>
        <iframe
          src={src}
          title={title || label}
          loading="lazy"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      className="ev-embed ev-embed--idle"
      style={{ aspectRatio: aspect }}
      onClick={() => setLoaded(true)}
    >
      <span className="ev-embed__play" aria-hidden="true" />
      <span className="ev-embed__label">{label}</span>
    </button>
  );
}

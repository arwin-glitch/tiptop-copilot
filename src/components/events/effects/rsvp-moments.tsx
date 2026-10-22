'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { EventTheme } from '@/lib/events/schema';
import { MAX_FLASHES_PER_SECOND } from '@/lib/events/theme/motion';
import { RSVP_MOMENT_EVENT, type RsvpMomentDetail } from './rsvp-moment-bus';
import { useLiveMotionScale, type IslandMotion } from './motion-runtime';

/**
 * The RSVP moment: plays once when a guest's RSVP comes back Going.
 * canvas-confetti is imported only when a moment actually plays, and runs
 * with disableForReducedMotion. Reduced motion, Pause or master Off: nothing
 * plays (the form's own "You're going ✓" state is the confirmation).
 */

type Moment = EventTheme['motion']['rsvpMoment'];

type ConfettiFn = (options: Record<string, unknown>) => Promise<undefined> | null;

async function loadConfetti(): Promise<
  ConfettiFn & { shapeFromPath?: (o: { path: string }) => unknown }
> {
  const mod = await import('canvas-confetti');
  return mod.default as unknown as ConfettiFn & {
    shapeFromPath?: (o: { path: string }) => unknown;
  };
}

const PETAL_PATH = 'M0 -8 C 6 -6, 6 6, 0 8 C -6 6, -6 -6, 0 -8 Z';

export function RsvpMoments({
  moment,
  colors,
  motion,
  allowPreviewOnly,
}: {
  moment: Moment;
  colors: string[];
  motion: IslandMotion;
  /** Studio: only Studio's explicit previews play. */
  allowPreviewOnly: boolean;
}) {
  const scale = useLiveMotionScale(motion);
  const [overlay, setOverlay] = useState<'ball' | 'stamp' | 'bloom' | 'warp' | null>(null);
  const timers = useRef<number[]>([]);

  const burst = useCallback(
    async (kind: 'confetti' | 'gold' | 'petals' | 'small') => {
      const confetti = await loadConfetti();
      const base = { disableForReducedMotion: true, zIndex: 80, colors };
      if (kind === 'gold') {
        void confetti({
          ...base,
          particleCount: Math.round(70 + 60 * scale),
          spread: 110,
          startVelocity: 28,
          gravity: 0.45,
          scalar: 0.7,
          ticks: 260,
          shapes: ['star', 'circle'],
          origin: { y: 0.65 },
        });
      } else if (kind === 'petals') {
        const petal = confetti.shapeFromPath?.({ path: PETAL_PATH });
        void confetti({
          ...base,
          particleCount: Math.round(40 + 40 * scale),
          spread: 120,
          startVelocity: 22,
          gravity: 0.35,
          drift: 0.6,
          ticks: 320,
          scalar: 1.6,
          ...(petal ? { shapes: [petal] } : {}),
          origin: { y: 0.3 },
        });
      } else {
        const count = kind === 'small' ? 50 : Math.round(90 + 90 * scale);
        void confetti({
          ...base,
          particleCount: count,
          spread: 75,
          startVelocity: 42,
          origin: { y: 0.7 },
        });
        if (kind === 'confetti' && scale >= 0.75) {
          timers.current.push(
            window.setTimeout(
              () => {
                void confetti({
                  ...base,
                  particleCount: 50,
                  angle: 60,
                  spread: 55,
                  origin: { x: 0, y: 0.75 },
                });
                void confetti({
                  ...base,
                  particleCount: 50,
                  angle: 120,
                  spread: 55,
                  origin: { x: 1, y: 0.75 },
                });
              },
              Math.round(1000 / MAX_FLASHES_PER_SECOND),
            ),
          );
        }
      }
    },
    [colors, scale],
  );

  const play = useCallback(() => {
    const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    switch (moment) {
      case 'none':
        return;
      case 'gold_dust':
        void burst('gold');
        return;
      case 'petals':
        void burst('petals');
        return;
      case 'ball_to_cup':
        setOverlay('ball');
        later(1250, () => void burst('confetti'));
        later(2100, () => setOverlay(null));
        return;
      case 'wax_stamp':
        setOverlay('stamp');
        later(1900, () => setOverlay(null));
        return;
      case 'glow_bloom':
        setOverlay('bloom');
        later(1600, () => setOverlay(null));
        return;
      case 'warp':
        setOverlay('warp');
        later(1100, () => setOverlay(null));
        return;
      case 'ticket_tear':
        void burst('small');
        return;
      case 'confetti':
      default:
        void burst('confetti');
    }
  }, [moment, burst]);

  useEffect(() => {
    const onRsvp = (e: Event) => {
      const detail = (e as CustomEvent<RsvpMomentDetail>).detail;
      if (!detail || detail.status !== 'going') return;
      if (allowPreviewOnly && !detail.preview) return;
      if (scale === 0) return;
      play();
    };
    window.addEventListener(RSVP_MOMENT_EVENT, onRsvp);
    return () => window.removeEventListener(RSVP_MOMENT_EVENT, onRsvp);
  }, [play, scale, allowPreviewOnly]);

  useEffect(() => {
    const list = timers.current;
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);

  if (!overlay) return null;
  const accent = colors[0] ?? '#D4AF37';
  return (
    <div
      className="ev-moment"
      data-moment={overlay}
      style={{ '--ev-moment-color': accent } as CSSProperties}
      aria-hidden="true"
    >
      {overlay === 'ball' ? (
        <svg className="ev-moment__green" viewBox="0 0 320 200" width="320" height="200">
          <ellipse cx="230" cy="168" rx="70" ry="14" fill="currentColor" opacity="0.18" />
          <ellipse cx="230" cy="166" rx="14" ry="5" fill="#111" />
          <line x1="230" y1="166" x2="230" y2="70" stroke="currentColor" strokeWidth="3" />
          <path d="M232 70 L280 84 L232 98 Z" fill={accent} />
          <circle className="ev-moment__ball" cx="0" cy="0" r="7" fill="#fff" stroke="#BFC5C9" />
        </svg>
      ) : null}
      {overlay === 'stamp' ? (
        <div className="ev-moment__stamp">
          <span>Going</span>
        </div>
      ) : null}
      {overlay === 'bloom' ? <div className="ev-moment__bloom" /> : null}
      {overlay === 'warp' ? (
        <div className="ev-moment__warp">
          {Array.from({ length: 24 }, (_, i) => (
            <span key={i} style={{ '--i': String(i) } as CSSProperties} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

'use client';

import { useSyncExternalStore, type CSSProperties } from 'react';
import { useLiveMotionScale, type IslandMotion } from './motion-runtime';

/**
 * The countdown: split-flap, digital, ring, minimal or constellation. Counts
 * to the start (absolute instants, so the venue zone is implied), shows the
 * live label between start and end and the ended label after. The server
 * renders a whole-days snapshot; the island ticks once a second while motion
 * runs and once a minute when it does not (no per-second change for reduced
 * motion).
 */

export type CountdownStyle = 'split_flap' | 'digital' | 'ring' | 'minimal' | 'constellation';

interface Parts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  state: 'before' | 'live' | 'after' | 'unknown';
}

export function countdownParts(startsAt: string | null, endsAt: string | null, now: number): Parts {
  const start = startsAt ? Date.parse(startsAt) : NaN;
  if (Number.isNaN(start)) return { days: 0, hours: 0, minutes: 0, seconds: 0, state: 'unknown' };
  const end = endsAt ? Date.parse(endsAt) : start + 3 * 3600_000;
  if (now >= end) return { days: 0, hours: 0, minutes: 0, seconds: 0, state: 'after' };
  if (now >= start) return { days: 0, hours: 0, minutes: 0, seconds: 0, state: 'live' };
  let s = Math.floor((start - now) / 1000);
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  return { days, hours, minutes, seconds: s - minutes * 60, state: 'before' };
}

const pad = (n: number) => String(n).padStart(2, '0');

/* One shared one-second clock for every countdown on the page. */
let clockNow = 0;
let clockTimer = 0;
const clockListeners = new Set<() => void>();

function subscribeClock(callback: () => void): () => void {
  clockListeners.add(callback);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = window.setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    clockListeners.delete(callback);
    if (!clockListeners.size) {
      window.clearInterval(clockTimer);
      clockTimer = 0;
    }
  };
}

function readClock(): number {
  if (!clockNow) clockNow = Date.now();
  return clockNow;
}

export function CountdownIsland({
  startsAt,
  endsAt,
  variant,
  liveLabel,
  endedLabel,
  fallback,
  motion,
}: {
  startsAt: string | null;
  endsAt: string | null;
  variant: CountdownStyle;
  liveLabel: string;
  endedLabel: string;
  /** What the server (and the hydrating client) shows: the date, not a moving number. */
  fallback: string;
  motion: IslandMotion;
}) {
  const scale = useLiveMotionScale(motion);
  const clock = useSyncExternalStore(subscribeClock, readClock, () => 0);
  if (!clock) {
    return <p className="ev-countdown__label ev-countdown__label--date">{fallback || 'Soon'}</p>;
  }
  // Paused or reduced motion: the numbers move once a minute, never every second.
  const now = scale > 0 ? clock : Math.floor(clock / 60_000) * 60_000;
  const p = countdownParts(startsAt, endsAt, now);
  if (p.state === 'unknown') return <p className="ev-countdown__label">Date to be announced</p>;
  if (p.state === 'live')
    return (
      <p className="ev-countdown__label ev-countdown__label--live">
        {liveLabel || 'Happening now'}
      </p>
    );
  if (p.state === 'after')
    return <p className="ev-countdown__label">{endedLabel || 'Thanks for coming'}</p>;

  const units: [number, string][] = [
    [p.days, p.days === 1 ? 'day' : 'days'],
    [p.hours, 'hours'],
    [p.minutes, 'min'],
    [p.seconds, 'sec'],
  ];
  const sr = `${p.days} days, ${p.hours} hours and ${p.minutes} minutes to go`;

  if (variant === 'minimal') {
    return (
      <p className="ev-countdown__minimal" aria-label={sr}>
        <span className="ev-countdown__big">{p.days}</span> {p.days === 1 ? 'day' : 'days'} to go
      </p>
    );
  }
  if (variant === 'ring' || variant === 'constellation') {
    const secProgress = p.seconds / 60;
    return (
      <div className="ev-countdown__rings" data-variant={variant} role="img" aria-label={sr}>
        {units.map(([value, label], i) => {
          const max = i === 0 ? Math.max(30, value) : i === 1 ? 24 : 60;
          const frac = i === 3 ? secProgress : value / max;
          return (
            <div key={label} className="ev-countdown__ring">
              {variant === 'constellation' ? (
                <svg viewBox="0 0 100 100" aria-hidden="true">
                  {Array.from({ length: 24 }, (_, k) => {
                    const a = (k / 24) * Math.PI * 2 - Math.PI / 2;
                    const lit = k / 24 < frac;
                    return (
                      <circle
                        key={k}
                        cx={(50 + Math.cos(a) * 42).toFixed(2)}
                        cy={(50 + Math.sin(a) * 42).toFixed(2)}
                        r={lit ? 2.6 : 1.4}
                        className={lit ? 'is-lit' : undefined}
                      />
                    );
                  })}
                </svg>
              ) : (
                <svg viewBox="0 0 100 100" aria-hidden="true">
                  <circle cx="50" cy="50" r="44" className="ev-countdown__track" />
                  <circle
                    cx="50"
                    cy="50"
                    r="44"
                    className="ev-countdown__arc"
                    style={
                      { strokeDasharray: `${(frac * 276.5).toFixed(1)} 276.5` } as CSSProperties
                    }
                  />
                </svg>
              )}
              <span className="ev-countdown__value">{pad(value)}</span>
              <span className="ev-countdown__unit">{label}</span>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="ev-countdown__cells" data-variant={variant} role="img" aria-label={sr}>
      {units.map(([value, label], i) => (
        <div key={label} className="ev-countdown__cell">
          <span className="ev-countdown__digits">
            {Array.from(pad(value)).map((d, k) => (
              <span
                key={`${k}-${d}`}
                className="ev-countdown__digit"
                data-flip={variant === 'split_flap' && scale > 0 ? 'true' : undefined}
              >
                {d}
              </span>
            ))}
          </span>
          <span className="ev-countdown__unit">{label}</span>
          {variant === 'digital' && i < units.length - 1 ? (
            <span className="ev-countdown__colon" aria-hidden="true">
              :
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

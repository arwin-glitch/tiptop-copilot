'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useLiveMotionScale, type IslandMotion } from './motion-runtime';

/**
 * Arrival intros: the personal envelope ("Dear Sarah," with the host logo as
 * the stamp, a postmark, a wax seal), a curtain, or a fade.
 *
 * - Shown once per visitor per event (a sessionStorage flag, no cookie), with
 *   a Skip button and Escape.
 * - Server-rendered closed, so the first paint is the envelope; if scripts
 *   never arrive a CSS failsafe fades it out after a few seconds (content
 *   never waits on JavaScript).
 * - Reduced motion: a tap cross-fades straight to the page.
 */

export type IntroKind = 'envelope' | 'curtain' | 'fade';

export interface EnvelopeView {
  color: string;
  liner: string;
  linerColor: string;
  sealColor: string;
  /** Already personalised on the server ("Dear Sarah,"). */
  greeting: string;
  postmark: string;
  stampUrl: string | null;
  monogram: string;
}

type Phase = 'closed' | 'flip' | 'open' | 'rise' | 'leave' | 'done';

const STORAGE_PREFIX = 'tiptop-event-intro:';

export function IntroGate({
  kind,
  eventKey,
  title,
  dateLine,
  envelope,
  colors,
  oncePerVisitor,
  motion,
}: {
  kind: IntroKind;
  eventKey: string;
  title: string;
  dateLine: string;
  envelope: EnvelopeView | null;
  colors: { bg: string; text: string; accent: string; accentFg: string; highlight: string };
  oncePerVisitor: boolean;
  motion: IslandMotion;
}) {
  const scale = useLiveMotionScale(motion);
  const [phase, setPhase] = useState<Phase>('closed');
  const [ready, setReady] = useState(false);
  const timers = useRef<number[]>([]);
  const openRef = useRef<HTMLButtonElement>(null);

  const finish = useCallback(() => {
    setPhase('done');
    if (oncePerVisitor) {
      try {
        window.sessionStorage.setItem(STORAGE_PREFIX + eventKey, '1');
      } catch {
        // Private mode: it shows again next time, which is fine.
      }
    }
  }, [eventKey, oncePerVisitor]);

  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  const leave = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    setPhase('leave');
    later(scale > 0 ? 480 : 260, finish);
  }, [finish, later, scale]);

  const open = useCallback(() => {
    if (phase !== 'closed') return;
    if (scale === 0 || kind === 'fade') {
      leave();
      return;
    }
    if (kind === 'curtain') {
      setPhase('open');
      later(1150, leave);
      return;
    }
    setPhase('flip');
    later(720, () => setPhase('open'));
    later(1480, () => setPhase('rise'));
    later(2450, leave);
  }, [phase, scale, kind, leave, later]);

  // Hydrated: honour "once per visitor", stop the CSS failsafe, focus the opener.
  useEffect(() => {
    let seen = false;
    if (oncePerVisitor) {
      try {
        seen = window.sessionStorage.getItem(STORAGE_PREFIX + eventKey) === '1';
      } catch {
        seen = false;
      }
    }
    const frame = window.requestAnimationFrame(() => {
      if (seen) {
        setPhase('done');
        return;
      }
      setReady(true);
      openRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [eventKey, oncePerVisitor]);

  // Fade and curtain move on by themselves after a beat.
  useEffect(() => {
    if (!ready || phase !== 'closed') return;
    if (kind === 'fade') later(scale > 0 ? 900 : 300, leave);
    if (kind === 'curtain' && scale > 0) later(1400, open);
  }, [ready, phase, kind, scale, later, leave, open]);

  useEffect(() => {
    if (phase === 'done') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') leave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, leave]);

  useEffect(() => {
    const list = timers.current;
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);

  if (phase === 'done') return null;

  const style = {
    '--ev-intro-bg': colors.bg,
    '--ev-intro-text': colors.text,
    '--ev-intro-accent': colors.accent,
    '--ev-intro-accent-fg': colors.accentFg,
    '--ev-intro-highlight': colors.highlight,
    ...(envelope
      ? {
          '--env': envelope.color,
          '--env-liner': envelope.linerColor,
          '--env-seal': envelope.sealColor,
        }
      : {}),
  } as CSSProperties;

  return (
    <div
      className="ev-intro"
      data-kind={kind}
      data-phase={phase}
      data-ready={ready ? 'true' : undefined}
      data-still={scale === 0 ? 'true' : undefined}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label={kind === 'envelope' ? 'Your invitation' : title}
    >
      <button type="button" className="ev-intro__skip" onClick={leave}>
        Skip
      </button>
      {kind === 'envelope' && envelope ? (
        <>
          <button
            ref={openRef}
            type="button"
            className="ev-env-stage"
            onClick={open}
            aria-label="Open the invitation"
          >
            <span className="ev-env">
              <span className="ev-env__front">
                <span className="ev-env__stamp">
                  {envelope.stampUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- resolved media URL (the host logo)
                    <img src={envelope.stampUrl} alt="" />
                  ) : (
                    <span className="ev-env__stamp-mark">{envelope.monogram}</span>
                  )}
                </span>
                {envelope.postmark ? <Postmark text={envelope.postmark} /> : null}
                <span className="ev-env__greeting">{envelope.greeting}</span>
                <span className="ev-env__sub">An invitation</span>
              </span>
              <span className="ev-env__back">
                <span className="ev-env__inside" />
                <span className="ev-env__card">
                  <span className="ev-env__card-eyebrow">You are invited</span>
                  <span className="ev-env__card-title">{title}</span>
                  {dateLine ? <span className="ev-env__card-date">{dateLine}</span> : null}
                </span>
                <span className="ev-env__pocket" />
                <span className="ev-env__flap" data-liner={envelope.liner}>
                  <span className="ev-env__flap-face" />
                  <span className="ev-env__flap-liner" />
                </span>
                <span className="ev-env__seal">
                  <span className="ev-env__seal-half ev-env__seal-half--l" />
                  <span className="ev-env__seal-half ev-env__seal-half--r" />
                  <span className="ev-env__seal-mark">{envelope.monogram}</span>
                </span>
              </span>
            </span>
          </button>
          <p className="ev-intro__hint" aria-hidden="true">
            Tap to open
          </p>
        </>
      ) : null}
      {kind === 'curtain' ? (
        <button
          ref={openRef}
          type="button"
          className="ev-curtain"
          onClick={open}
          aria-label={`Enter: ${title}`}
        >
          <span className="ev-curtain__panel ev-curtain__panel--l" />
          <span className="ev-curtain__panel ev-curtain__panel--r" />
          <span className="ev-curtain__valance" />
          <span className="ev-curtain__plaque">
            <span className="ev-curtain__title">{title}</span>
            {dateLine ? <span className="ev-curtain__date">{dateLine}</span> : null}
          </span>
        </button>
      ) : null}
      {kind === 'fade' ? (
        <button
          ref={openRef}
          type="button"
          className="ev-fade-intro"
          onClick={leave}
          aria-label={`Enter: ${title}`}
        >
          <span className="ev-fade-intro__title">{title}</span>
          {dateLine ? <span className="ev-fade-intro__date">{dateLine}</span> : null}
        </button>
      ) : null}
    </div>
  );
}

function Postmark({ text }: { text: string }) {
  const label = text.toUpperCase().slice(0, 40);
  return (
    <span className="ev-env__postmark" aria-hidden="true">
      <svg viewBox="0 0 220 120" width="220" height="120">
        <defs>
          <path id="ev-postmark-arc" d="M 128 60 m -38 0 a 38 38 0 1 1 76 0" />
          <path id="ev-postmark-arc-b" d="M 128 60 m 34 0 a 34 34 0 1 1 -68 0" />
        </defs>
        <g fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="128" cy="60" r="46" />
          <circle cx="128" cy="60" r="30" />
          <path d="M4 40 q 12 -8 24 0 t 24 0 t 24 0 t 24 0" />
          <path d="M4 56 q 12 -8 24 0 t 24 0 t 24 0 t 24 0" />
          <path d="M4 72 q 12 -8 24 0 t 24 0 t 24 0 t 24 0" />
        </g>
        <text fontSize="9" letterSpacing="1.5" fill="currentColor">
          <textPath href="#ev-postmark-arc" startOffset="50%" textAnchor="middle">
            {label}
          </textPath>
        </text>
        <text
          x="128"
          y="64"
          fontSize="10"
          textAnchor="middle"
          fill="currentColor"
          letterSpacing="1"
        >
          RSVP
        </text>
      </svg>
    </span>
  );
}

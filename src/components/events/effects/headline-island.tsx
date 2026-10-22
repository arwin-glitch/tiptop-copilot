'use client';

import { useEffect, useRef, useState } from 'react';
import { ENTRANCE_CAP_MS } from '@/lib/events/theme/motion';
import { useInView, useLiveMotionScale, type IslandMotion } from './motion-runtime';

/**
 * Headline effects that need script: split-flap, scramble/decrypt and
 * typewriter. The server renders the final text (the heading's accessible
 * name is always the real text, via aria-label); this island only animates
 * the visible glyphs once, when the heading first comes into view, and never
 * runs under reduced motion, Pause or master Off.
 */

const FLAP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SCRAMBLE = '!<>-_\\/[]{}=+*^?#________';

export function HeadlineIsland({
  text,
  effect,
  speed,
  motion,
}: {
  text: string;
  effect: 'split_flap' | 'scramble' | 'typewriter';
  speed: number;
  motion: IslandMotion;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, '0px');
  const scale = useLiveMotionScale(motion);
  const [shown, setShown] = useState(text);
  const [caret, setCaret] = useState(false);
  const played = useRef(false);

  useEffect(() => {
    if (!inView || played.current || scale === 0) return;
    played.current = true;
    const chars = Array.from(text);
    // Stays within roughly 2× the entrance cap overall, whatever the length.
    const total = Math.min(ENTRANCE_CAP_MS * 2.2, 420 + chars.length * 34) / Math.max(0.5, speed);
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / total);
      if (effect === 'typewriter') setCaret(p < 1);
      if (effect === 'typewriter') {
        setShown(chars.slice(0, Math.ceil(p * chars.length)).join(''));
      } else {
        const pool = effect === 'split_flap' ? FLAP : SCRAMBLE;
        setShown(
          chars
            .map((ch, i) => {
              if (ch === ' ') return ' ';
              const settleAt = (i + 1) / chars.length;
              if (p >= settleAt) return ch;
              return pool[Math.floor(Math.random() * pool.length)] ?? ch;
            })
            .join(''),
        );
      }
      if (p < 1) raf = requestAnimationFrame(tick);
      else setShown(text);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      // Interrupted: show the real headline, never scrambled glyphs.
      cancelAnimationFrame(raf);
      setShown(text);
      setCaret(false);
    };
  }, [inView, scale, text, effect, speed]);

  return (
    <span ref={ref} className="ev-hl-island" data-effect={effect} aria-hidden="true">
      {effect === 'split_flap' ? <Flaps text={text} shown={shown} /> : shown}
      {caret ? <span className="ev-caret" /> : null}
    </span>
  );
}

/** Split-flap tiles grouped by word, so a line never breaks inside a word. */
function Flaps({ text, shown }: { text: string; shown: string }) {
  const target = Array.from(text);
  const current = Array.from(shown);
  const words: { start: number; end: number }[] = [];
  let start = -1;
  target.forEach((ch, i) => {
    if (ch === ' ') {
      if (start >= 0) words.push({ start, end: i });
      start = -1;
    } else if (start < 0) start = i;
  });
  if (start >= 0) words.push({ start, end: target.length });
  return (
    <>
      {words.map((w, k) => (
        <span key={k} className="ev-flap-word">
          {current.slice(w.start, w.end).map((ch, i) => (
            <span key={i} className="ev-flap">
              {ch}
            </span>
          ))}
        </span>
      ))}
    </>
  );
}

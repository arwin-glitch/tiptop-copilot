'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { setMotionPaused, useMotionPaused, usePrefersReducedMotion } from './motion-runtime';

/**
 * The visible "Pause animations" control (WCAG 2.2.2), on every page with
 * looping motion. The choice is remembered per visitor and applies to every
 * engine (CSS animations pause via [data-paused] on the root; canvas and
 * WebGL islands read the same store). Hidden when the visitor's system
 * already asks for reduced motion (nothing loops then).
 */
export function PauseMotion({
  position,
  forced,
}: {
  position: 'bottom-left' | 'bottom-right';
  forced: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const paused = useMotionPaused();
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const root = ref.current?.closest('[data-event-root]');
    if (!root) return;
    if (paused) root.setAttribute('data-paused', 'true');
    else root.removeAttribute('data-paused');
  }, [paused]);

  if (reduced && !forced) return null;
  return (
    <button
      ref={ref}
      type="button"
      className="ev-pause"
      data-position={position}
      aria-pressed={paused}
      onClick={() => setMotionPaused(!paused)}
    >
      {paused ? <Play aria-hidden="true" size={14} /> : <Pause aria-hidden="true" size={14} />}
      <span>{paused ? 'Play animations' : 'Pause animations'}</span>
    </button>
  );
}

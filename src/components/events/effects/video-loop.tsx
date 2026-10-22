'use client';

import { useEffect, useRef } from 'react';
import {
  useInView,
  useMotionPaused,
  usePageVisible,
  usePrefersReducedMotion,
} from './motion-runtime';

/**
 * A muted, looping background video that plays only when allowed: motion on,
 * no reduced-motion preference, not paused by the visitor, on screen and the
 * tab visible. Otherwise the poster stays (also what iOS Low Power Mode
 * shows when it blocks autoplay).
 */
export function VideoLoop({
  sources,
  poster,
  autoplay,
  className,
  label,
  objectPosition,
}: {
  sources: { url: string; type: string }[];
  poster?: string;
  autoplay: boolean;
  className?: string;
  label: string;
  objectPosition?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const inView = useInView(ref, '0px');
  const visible = usePageVisible();
  const paused = useMotionPaused();
  const reduced = usePrefersReducedMotion();
  const shouldPlay = autoplay && inView && visible && !paused && !reduced;

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (shouldPlay) {
      void video.play().catch(() => {
        // Autoplay refused (Low Power Mode, data saver): the poster stays.
      });
    } else {
      video.pause();
    }
  }, [shouldPlay]);

  return (
    <video
      ref={ref}
      className={className}
      poster={poster}
      muted
      loop
      playsInline
      preload={autoplay ? 'metadata' : 'none'}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      style={{ objectPosition }}
    >
      {sources.map((s) => (
        <source key={s.url} src={s.url} type={s.type} />
      ))}
    </video>
  );
}

'use client';

import { useEffect, useRef } from 'react';

/**
 * Scroll entrances, fallback half. Browsers with CSS scroll-driven animation
 * (animation-timeline: view()) animate .ev-reveal in pure CSS; for the rest
 * this island marks elements as they enter the viewport.
 *
 * Content never depends on it: only elements that are BELOW the fold when
 * this runs are hidden (data-reveal="pending"), so the first screen never
 * blinks, and without JavaScript everything is simply visible.
 */
export function RevealObserver() {
  const ref = useRef<HTMLSpanElement>(null);
  // The hero's CSS loops rest while it is off screen (event-effects.css).
  useEffect(() => {
    const root = ref.current?.closest('[data-event-root]');
    const hero = root?.querySelector('.ev-section[data-block="hero"]');
    if (!root || !hero || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) root.removeAttribute('data-hero-offscreen');
      else root.setAttribute('data-hero-offscreen', '');
    });
    io.observe(hero);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const root = ref.current?.closest('[data-event-root]');
    if (!root) return;
    const supportsView =
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('animation-timeline: view()');
    if (supportsView || typeof IntersectionObserver === 'undefined') return;
    root.setAttribute('data-reveal-js', 'true');
    const fold = window.innerHeight;
    const pending = Array.from(root.querySelectorAll<HTMLElement>('.ev-reveal')).filter(
      (el) => el.getBoundingClientRect().top > fold,
    );
    for (const el of pending) el.setAttribute('data-reveal', 'pending');
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute('data-reveal', 'in');
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    for (const el of pending) io.observe(el);
    return () => io.disconnect();
  }, []);
  return <span ref={ref} hidden />;
}

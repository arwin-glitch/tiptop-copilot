'use client';

import { preload } from 'react-dom';

/**
 * Starts the theme's display and body faces downloading with the HTML
 * (React puts the <link rel="preload"> in the head during server rendering),
 * so a headline rarely swaps fonts after first paint, which would shift the
 * page. Renders nothing.
 */
export function FontPreload({ hrefs }: { hrefs: readonly string[] }) {
  for (const href of hrefs) {
    preload(href, { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  }
  return null;
}

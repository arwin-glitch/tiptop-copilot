import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The type scale added in `globals.css` — `--text-micro`, `--text-read` and so
 * on, which Tailwind turns into `text-micro`, `text-read` … utilities.
 *
 * These have to be declared to tailwind-merge as well, and the reason is not
 * obvious. tailwind-merge resolves conflicts by pattern, and `text-*` is used
 * by both font size and text colour. It knows Tailwind's built-in sizes
 * (`text-sm`, `text-lg`) and assumes anything else after `text-` is a colour.
 * So `cn('text-micro', 'text-[var(--fg-subtle)]')` looked like two competing
 * colours and it silently dropped the first — the label kept its colour and
 * lost its size, inheriting 16px from the body.
 *
 * Nothing failed: the build passed, the types passed, all 473 unit tests and 38
 * end-to-end tests passed, and every uppercase micro-label on the site quietly
 * rendered at body size. Only opening the page found it. Adding the names to
 * the `font-size` group is what makes the two utilities coexist.
 */
const FONT_SIZES = ['micro', 'mini', 'note', 'read', 'title', 'display', 'display-lg'];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: FONT_SIZES }],
    },
  },
});

/** Merge conditional class names with Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

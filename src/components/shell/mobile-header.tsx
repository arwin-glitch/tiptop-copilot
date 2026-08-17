'use client';

import { usePathname } from 'next/navigation';
import { sectionLabel } from './nav';

/**
 * Where you are, on a phone.
 *
 * The mobile header showed the product name and nothing else, so the only clue
 * to the current section was which of five bottom-bar icons was tinted. This
 * puts the section name in the header, breadcrumb-style.
 *
 * It is a `<span>`, deliberately not a heading: the accessibility suite asserts
 * exactly one `h1` per page and that `h1` belongs to the page content, not to
 * the chrome around it. `aria-hidden` because the bottom bar already announces
 * the current page through `aria-current`, and hearing the section name twice
 * on every navigation is noise.
 */
export function MobileSectionLabel() {
  const pathname = usePathname();
  const label = sectionLabel(pathname);
  if (!label) return null;

  return (
    <span aria-hidden="true" className="flex min-w-0 items-center gap-2">
      <span className="h-3.5 w-px shrink-0 bg-[var(--border-strong)]" />
      <span className="truncate text-sm font-medium text-[var(--fg-muted)]">{label}</span>
    </span>
  );
}

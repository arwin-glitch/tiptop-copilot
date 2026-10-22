import Link from 'next/link';
import { FilterChipRow, filterChipClassName } from '@/components/ui/toolbar';

export interface LinkChip {
  key: string;
  label: string;
  count?: number;
  href: string;
  active: boolean;
  /** Something here waits for a person: the count shows in the warning colour. */
  attention?: boolean;
}

/**
 * A row of filter chips that are links: the URL holds the filter and the
 * server renders the result, like the subtabs above them. Server-rendered,
 * so a filter costs no client JavaScript. The current chip carries
 * `aria-current`, and the count is part of the link's name.
 */
export function LinkChips({
  label,
  chips,
  className,
}: {
  /** Accessible name of the group, e.g. "Filter by list". */
  label: string;
  chips: readonly LinkChip[];
  className?: string;
}) {
  return (
    <FilterChipRow aria-label={label} className={className}>
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={chip.href}
          prefetch={false}
          scroll={false}
          aria-current={chip.active ? 'page' : undefined}
          className={filterChipClassName(chip.active)}
        >
          {chip.label}
          {chip.count !== undefined ? (
            <span
              className={
                chip.attention
                  ? 'tabular ml-1.5 font-semibold text-[var(--warn)]'
                  : 'tabular ml-1.5 text-[var(--fg-subtle)]'
              }
            >
              {chip.count.toLocaleString('en-US')}
            </span>
          ) : null}
        </Link>
      ))}
    </FilterChipRow>
  );
}

/**
 * A page URL from its params: empty values left out, and `tab` left out when
 * it is the page's default, so the bare path stays the default tab's link.
 */
export function pageHref(
  path: string,
  params: Readonly<Record<string, string | null | undefined>>,
  defaultTab?: string,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!value) continue;
    if (key === 'tab' && value === defaultTab) continue;
    search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

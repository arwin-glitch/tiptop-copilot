'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BookOpen,
  Briefcase,
  Users,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  Inbox,
  Landmark,
  MailCheck,
  MessageSquare,
  Newspaper,
  Settings,
  Sun,
  Target,
} from 'lucide-react';
import { cn } from '@/lib/util/cn';
import { FieldLabel } from '@/components/ui/card';

/**
 * Navigation.
 *
 * A dozen flat destinations is well past the point at which a sidebar stops being scanned
 * and starts being read, so these are grouped by what the reader is actually
 * doing: **Working** is the daily loop, **Records** is the material it runs on,
 * **System** is configuration. `/diagnostics` joins the list here — it is a
 * real route that had no entry anywhere and was reachable only by typing the
 * URL.
 *
 * One `<nav>` element, not three. The accessibility suite locates the sidebar
 * and the bottom bar by `aria-label="Main"` and asserts the *last* one is the
 * bottom bar; splitting the sidebar into a nav per group would put three
 * identically-named landmarks in between and change what "last" means.
 *
 * There is no Lists entry: Affinity's lists are an import, not a place Nick
 * works. Their rows feed the pages that use them, and the lists themselves
 * sit under Knowledge (Affinity lists, Affinity import). A list or record
 * page under `/lists/` therefore marks Knowledge as the current section.
 */
export const NAV_ITEMS = [
  { href: '/today', label: 'Today', icon: Sun },
  { href: '/follow-ups', label: 'Follow-ups', icon: MailCheck },
  { href: '/tasks', label: 'Tasks', icon: CheckSquare },
  { href: '/deals', label: 'Deals', icon: Target },
  { href: '/ask', label: 'Ask', icon: MessageSquare },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/calendar', label: 'Calendar', icon: CalendarClock },
  { href: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { href: '/fund-ii', label: 'Fund II', icon: Landmark },
  { href: '/meetings', label: 'Meetings', icon: CalendarDays },
  { href: '/network', label: 'Network', icon: Users },
  { href: '/updates', label: 'Reports', icon: Newspaper },
  { href: '/knowledge', label: 'Knowledge', icon: BookOpen, also: ['/lists'] },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

// Diagnostics is an operator page: it stays a real route, linked from
// Settings, but is no longer a destination in the main navigation.
const GROUPS: { label: string; hrefs: string[] }[] = [
  {
    label: 'Working',
    hrefs: ['/today', '/follow-ups', '/tasks', '/deals', '/ask', '/inbox', '/calendar'],
  },
  {
    label: 'Records',
    hrefs: ['/portfolio', '/fund-ii', '/meetings', '/network', '/updates', '/knowledge'],
  },
  { label: 'System', hrefs: ['/settings'] },
];

type NavItem = (typeof NAV_ITEMS)[number];

function under(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** A path is in an item's section at its own href or one of the paths it also covers. */
export function isActive(
  pathname: string,
  item: Pick<NavItem, 'href'> & { also?: readonly string[] },
): boolean {
  return under(pathname, item.href) || (item.also ?? []).some((path) => under(pathname, path));
}

/** The label for the section a path belongs to, for the mobile header. */
export function sectionLabel(pathname: string): string | null {
  const match = NAV_ITEMS.find((i) => isActive(pathname, i));
  return match?.label ?? null;
}

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {GROUPS.map((group) => {
        const headingId = `nav-group-${group.label.toLowerCase()}`;
        return (
          <div key={group.label}>
            {/* Gold small caps: the one place the sidebar spends its accent
                on text, so the group names read as engraved headings. */}
            <FieldLabel
              as="p"
              id={headingId}
              className="px-2.5 pb-1.5 tracking-[0.18em] text-[var(--label-gold)]"
            >
              {group.label}
            </FieldLabel>
            <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
              {group.hrefs.map((href) => {
                const item = NAV_ITEMS.find((i) => i.href === href);
                if (!item) return null;
                const active = isActive(pathname, item);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        // The 2px rail is the active marker rather than a
                        // filled pill: it survives both themes at the same
                        // weight, and it reads as an index mark down the edge
                        // of the page instead of a button that looks pressed.
                        'relative flex items-center gap-2.5 rounded-md py-2 pr-2.5 pl-4 text-sm transition-colors duration-[var(--motion-instant)]',
                        'before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[2px] before:rounded-full before:transition-colors before:duration-[var(--motion-instant)]',
                        active
                          ? 'bg-[var(--nav-active)] font-medium text-[var(--fg)] shadow-[inset_0_0_0_1px_var(--border)] before:bg-[var(--gold)]'
                          : 'text-[var(--fg-muted)] before:bg-transparent hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-4 shrink-0',
                          active ? 'text-[var(--accent)]' : 'text-[var(--fg-subtle)]',
                        )}
                        aria-hidden="true"
                      />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Below the sidebar breakpoint: every destination in one bottom bar that
 * scrolls sideways. It used to hold only the first six, which left Tasks,
 * Meetings and the rest unreachable in a narrow window. Items keep a fixed
 * width so the bar scrolls instead of squeezing, the edges fade while there
 * is more to scroll to, and the current page is scrolled into view.
 */
export function MobileNav() {
  const pathname = usePathname();
  const listRef = React.useRef<HTMLUListElement>(null);
  const [more, setMore] = React.useState({ left: false, right: false });

  const measure = React.useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const left = list.scrollLeft > 1;
    const right = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
    setMore((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // Set scrollLeft rather than calling scrollIntoView: Chrome moves the
    // keyboard's sequential-focus starting point to a scrolled-into-view
    // element, so the first Tab would skip the skip link.
    const current = list.querySelector<HTMLElement>('[aria-current="page"]');
    if (current) {
      const start = current.offsetLeft - list.offsetLeft;
      const end = start + current.offsetWidth;
      if (start < list.scrollLeft || end > list.scrollLeft + list.clientWidth) {
        list.scrollLeft = start - (list.clientWidth - current.offsetWidth) / 2;
      }
    }
    measure();
  }, [pathname, measure]);

  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    // A mouse wheel scrolls vertically; over the bar, turn it sideways.
    // Registered natively because React's wheel listener is passive and could
    // not stop the page scrolling underneath.
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (list.scrollWidth <= list.clientWidth) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    };
    list.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      list.removeEventListener('wheel', onWheel);
    };
  }, [measure]);

  return (
    <nav
      aria-label="Main"
      // Emerald in both themes, like the desktop rail, with a gold top edge.
      className="dark fixed inset-x-0 bottom-0 z-[var(--z-nav)] bg-[var(--bg-sidebar)] pb-[env(safe-area-inset-bottom)] text-[var(--fg)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-[linear-gradient(90deg,rgb(212_175_55/0.3),var(--gold)_30%,var(--gold)_70%,rgb(212_175_55/0.3))] lg:hidden"
    >
      <ul
        ref={listRef}
        onScroll={measure}
        className="flex snap-x [scrollbar-width:none] overflow-x-auto overscroll-x-contain [&::-webkit-scrollbar]:hidden"
      >
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item);
          const Icon = item.icon;
          return (
            <li key={item.href} className="min-w-[4.75rem] flex-1 shrink-0 snap-start">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  // min-h-14 keeps every target comfortably past the 44px the
                  // suite asserts, including with the safe-area inset applied.
                  'text-micro relative flex min-h-14 flex-col items-center justify-center gap-1 px-1 whitespace-nowrap transition-colors duration-[var(--motion-instant)]',
                  active ? 'text-[var(--fg)]' : 'text-[var(--fg-subtle)]',
                )}
              >
                {/* The rail sits on top here rather than at the side, so the
                    active marker means the same thing at both sizes. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute inset-x-4 top-0 h-[2px] rounded-full transition-colors duration-[var(--motion-instant)]',
                    active ? 'bg-[var(--accent)]' : 'bg-transparent',
                  )}
                />
                <Icon
                  className={cn('size-5', active ? 'text-[var(--accent)]' : undefined)}
                  aria-hidden="true"
                />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute top-0 bottom-[env(safe-area-inset-bottom)] left-0 w-8 bg-gradient-to-r from-[var(--bg-sidebar)] to-transparent transition-opacity duration-[var(--motion-instant)]',
          more.left ? 'opacity-100' : 'opacity-0',
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute top-0 right-0 bottom-[env(safe-area-inset-bottom)] w-8 bg-gradient-to-l from-[var(--bg-sidebar)] to-transparent transition-opacity duration-[var(--motion-instant)]',
          more.right ? 'opacity-100' : 'opacity-0',
        )}
      />
    </nav>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BookOpen,
  Briefcase,
  CheckSquare,
  Inbox,
  MessageSquare,
  Settings,
  Sun,
  Target,
} from 'lucide-react';
import { cn } from '@/lib/util/cn';
import { FieldLabel } from '@/components/ui/card';

/**
 * Navigation.
 *
 * Eight flat destinations is the point at which a sidebar stops being scanned
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
 */
export const NAV_ITEMS = [
  { href: '/today', label: 'Today', icon: Sun },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/deals', label: 'Deals', icon: Target },
  { href: '/ask', label: 'Ask', icon: MessageSquare },
  { href: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { href: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { href: '/tasks', label: 'Tasks', icon: CheckSquare },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/diagnostics', label: 'Diagnostics', icon: Activity },
] as const;

const GROUPS: { label: string; hrefs: string[] }[] = [
  { label: 'Working', hrefs: ['/today', '/inbox', '/deals', '/ask'] },
  { label: 'Records', hrefs: ['/portfolio', '/knowledge', '/tasks'] },
  { label: 'System', hrefs: ['/settings', '/diagnostics'] },
];

/** Mobile: five primary destinations in a bottom bar, thumb-reachable. */
const MOBILE_HREFS = ['/today', '/inbox', '/deals', '/ask', '/portfolio'];
const MOBILE_ITEMS = NAV_ITEMS.filter((i) => MOBILE_HREFS.includes(i.href));

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The label for the section a path belongs to, for the mobile header. */
export function sectionLabel(pathname: string): string | null {
  const match = NAV_ITEMS.find((i) => isActive(pathname, i.href));
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
            <FieldLabel as="p" id={headingId} className="px-2.5 pb-1.5">
              {group.label}
            </FieldLabel>
            <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
              {group.hrefs.map((href) => {
                const item = NAV_ITEMS.find((i) => i.href === href);
                if (!item) return null;
                const active = isActive(pathname, item.href);
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
                          ? 'bg-[var(--bg-hover)] font-medium text-[var(--fg)] before:bg-[var(--accent)]'
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

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-[var(--z-nav)] border-t border-[var(--border)] bg-[var(--bg-raised)] pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="grid grid-cols-5">
        {MOBILE_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  // min-h-14 keeps every target comfortably past the 44px the
                  // suite asserts, including with the safe-area inset applied.
                  'text-micro relative flex min-h-14 flex-col items-center justify-center gap-1 transition-colors duration-[var(--motion-instant)]',
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
    </nav>
  );
}

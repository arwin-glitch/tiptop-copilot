import { redirect } from 'next/navigation';
import { after } from 'next/server';
import Link from 'next/link';
import { getAuthContext } from '@/lib/auth/session';
import { isDemoMode } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { recordVisit } from '@/lib/services/presence';
import { GoldFiligree } from '@/components/brand/gold-filigree';
import { Mark, Wordmark } from '@/components/brand/wordmark';
import { MobileNav, SidebarNav } from '@/components/shell/nav';
import { CommandPalette } from '@/components/shell/command-palette';
import { MobileSectionLabel } from '@/components/shell/mobile-header';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { SignOutButton } from '@/components/shell/sign-out';
import { TaskActionHost } from '@/components/tasks/task-action-host';
import { Badge } from '@/components/ui/badge';
import { FieldLabel } from '@/components/ui/card';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');

  const demo = isDemoMode();
  // "Last opened the app" for the people Nick works with; after the response, so
  // a store fault can never slow or break a page.
  if (!demo) {
    const { organizationId, userId } = auth;
    after(() => recordVisit(getStore(), organizationId, userId));
  }
  const displayName = auth.profile.full_name ?? auth.profile.email;

  return (
    <div className={demo ? 'has-demo-banner flex min-h-dvh flex-col' : 'flex min-h-dvh flex-col'}>
      {demo ? (
        <div
          role="status"
          className="text-mini sticky top-0 z-[var(--z-banner)] flex items-center justify-center gap-2 border-b border-[var(--border-strong)] bg-[var(--accent-soft)] px-3 py-1.5 text-center text-[var(--fg)]"
        >
          <strong className="font-semibold">Demo mode</strong>
          <span className="text-[var(--fg-muted)]">
            Every company, person and number here is fictional. This is not real TipTop data.
          </span>
        </div>
      ) : null}

      <div className="flex flex-1">
        {/* The rail is emerald in both themes: `dark` re-scopes every token
            inside it, so light mode gets the same emerald panel (and
            text colour has to be restated, since it inherits from <body>).
            Remove the class to give light mode a parchment rail instead. Its
            right edge is a gold hairline rather than a border, the line the
            reference draws between two emerald panels. */}
        <aside className="dark sticky top-0 isolate hidden h-dvh w-64 shrink-0 flex-col bg-[var(--bg-sidebar)] bg-[linear-gradient(180deg,rgb(31_90_70/0.25),transparent_40%,transparent_70%,rgb(0_0_0/0.18))] px-3 py-4 text-[var(--fg)] after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-[linear-gradient(180deg,rgb(212_175_55/0.25),var(--gold)_18%,var(--gold)_82%,rgb(212_175_55/0.25))] lg:flex">
          <GoldFiligree variant="sidebar" />
          <Link
            href="/today"
            className="rounded-md px-1.5 pb-6 transition-opacity duration-[var(--motion-instant)] hover:opacity-80"
          >
            <Wordmark />
          </Link>

          <CommandPalette className="mb-4 w-full" />

          <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto">
            <SidebarNav />
          </div>

          {/* Account controls. A block rather than a menu: everything here is
              one control deep, and burying a two-click theme switch behind a
              three-click menu is not an improvement. */}
          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <div className="flex items-center gap-2.5 px-1.5">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--jewel)] font-serif text-sm font-semibold text-[var(--jewel-fg)] ring-1 ring-[var(--border-strong)]"
              >
                {initials(displayName)}
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-sm font-medium">{displayName}</span>
                <span className="text-mini truncate text-[var(--fg-muted)]">
                  {auth.organization.name}
                </span>
              </span>
            </div>

            <FieldLabel as="p" className="mt-2.5 px-1.5">
              {auth.role} · {auth.profile.timezone}
            </FieldLabel>

            <div className="mt-2.5 flex items-center justify-between gap-2 px-1.5">
              <ThemeToggle />
              <SignOutButton />
            </div>
          </div>
        </aside>

        {/* `overflow-x-clip` holds the page-header band (a spread shadow) to
            this column, so it never paints over the rail. `clip`, not
            `hidden`: it makes no scroll container, so the sticky phone header
            and a page's sticky subtab bar below still stick. */}
        <div className="flex min-w-0 flex-1 flex-col overflow-x-clip">
          {/* Emerald in both themes, like the rail it stands in for: on a
              phone this bar and the bottom one are the frame, so paper-white
              content still sits inside emerald chrome with a gold edge. A
              fixed height rather than padding: a page's subtab bar sticks
              just below it, at --app-header-h. */}
          <header className="dark sticky top-0 z-[var(--z-header)] flex h-[var(--app-header-h)] items-center justify-between gap-3 bg-[var(--bg-sidebar)]/95 px-4 text-[var(--fg)] backdrop-blur after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[linear-gradient(90deg,rgb(212_175_55/0.3),var(--gold)_30%,var(--gold)_70%,rgb(212_175_55/0.3))] lg:hidden">
            <div className="flex min-w-0 items-center gap-2">
              {/* Named just "TipTop Copilot", not "… — Today": Playwright
                  matches accessible names by substring unless told otherwise,
                  so a label mentioning a nav destination would shadow the real
                  nav link in any `getByRole('link', { name: 'Today' })`. */}
              <Link href="/today" aria-label="TipTop Copilot" className="shrink-0">
                <Mark className="text-[var(--brand-mark)]" size={20} />
              </Link>
              <MobileSectionLabel />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {demo ? <Badge tone="accent">Demo</Badge> : null}
              <CommandPalette shortcut={false} className="px-2 py-1" />
              <ThemeToggle />
            </div>
          </header>

          <main id="main" className="min-w-0 flex-1 pb-20 lg:pb-0">
            <TaskActionHost>{children}</TaskActionHost>
          </main>
        </div>
      </div>

      <MobileNav />
    </div>
  );
}

/**
 * Up to two initials for the account block. Falls back to the first character
 * of an email local part, which is what a profile with no name gives us.
 */
function initials(name: string): string {
  const parts = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

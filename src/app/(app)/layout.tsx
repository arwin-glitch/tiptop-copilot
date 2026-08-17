import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getAuthContext } from '@/lib/auth/session';
import { isDemoMode } from '@/lib/config/env';
import { Mark, Wordmark } from '@/components/brand/wordmark';
import { MobileNav, SidebarNav } from '@/components/shell/nav';
import { MobileSectionLabel } from '@/components/shell/mobile-header';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { SignOutButton } from '@/components/shell/sign-out';
import { Badge } from '@/components/ui/badge';
import { FieldLabel } from '@/components/ui/card';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');

  const demo = isDemoMode();
  const displayName = auth.profile.full_name ?? auth.profile.email;

  return (
    <div className="flex min-h-dvh flex-col">
      {demo ? (
        <div
          role="status"
          className="text-mini sticky top-0 z-[var(--z-banner)] flex items-center justify-center gap-2 border-b border-[var(--warn)]/25 bg-[var(--warn-soft)] px-3 py-1.5 text-center text-[var(--fg)]"
        >
          <strong className="font-semibold">Demo mode</strong>
          <span className="text-[var(--fg-muted)]">
            Every company, person and number here is fictional. This is not real TipTop data.
          </span>
        </div>
      ) : null}

      <div className="flex flex-1">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-raised)] px-3 py-4 lg:flex">
          <Link
            href="/today"
            className="rounded-md px-1.5 pb-6 transition-opacity duration-[var(--motion-instant)] hover:opacity-80"
          >
            <Wordmark />
          </Link>

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
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--accent-soft)] font-serif text-sm font-semibold text-[var(--accent)]"
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

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-[var(--z-header)] flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)]/95 px-4 py-2.5 backdrop-blur lg:hidden">
            <div className="flex min-w-0 items-center gap-2">
              {/* Named just "TipTop Copilot", not "… — Today": Playwright
                  matches accessible names by substring unless told otherwise,
                  so a label mentioning a nav destination would shadow the real
                  nav link in any `getByRole('link', { name: 'Today' })`. */}
              <Link href="/today" aria-label="TipTop Copilot" className="shrink-0">
                <Mark className="text-[var(--accent)]" size={20} />
              </Link>
              <MobileSectionLabel />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {demo ? <Badge tone="warn">Demo</Badge> : null}
              <ThemeToggle />
            </div>
          </header>

          <main id="main" className="min-w-0 flex-1 pb-20 lg:pb-0">
            {children}
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

import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth/session';
import { isDemoMode } from '@/lib/config/env';
import { Wordmark } from '@/components/brand/wordmark';
import { MobileNav, SidebarNav } from '@/components/shell/nav';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { SignOutButton } from '@/components/shell/sign-out';
import { Badge } from '@/components/ui/badge';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');

  const demo = isDemoMode();

  return (
    <div className="flex min-h-dvh flex-col">
      {demo ? (
        <div
          role="status"
          className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-[var(--warn-soft)] px-3 py-1.5 text-center text-[12px] text-[var(--fg)]"
        >
          <strong className="font-semibold">Demo mode</strong>
          <span className="text-[var(--fg-muted)]">
            Every company, person and number here is fictional. This is not real TipTop data.
          </span>
        </div>
      ) : null}

      <div className="flex flex-1">
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-raised)] px-3 py-4 lg:flex">
          <div className="px-1.5 pb-5">
            <Wordmark />
          </div>
          <SidebarNav />
          <div className="mt-auto space-y-3 px-1.5 pt-4">
            <div className="border-t border-[var(--border)] pt-3">
              <p className="truncate text-sm font-medium">
                {auth.profile.full_name ?? auth.profile.email}
              </p>
              <p className="truncate text-xs text-[var(--fg-muted)]">{auth.organization.name}</p>
              <p className="mt-1 text-[11px] text-[var(--fg-subtle)]">
                {auth.role} · {auth.profile.timezone}
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <ThemeToggle />
              <SignOutButton />
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)]/95 px-4 py-2.5 backdrop-blur lg:hidden">
            <Wordmark showSubtitle={false} />
            <div className="flex items-center gap-2">
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

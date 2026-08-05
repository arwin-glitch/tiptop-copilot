import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { enterDemoAction } from '@/app/actions/session';
import { Wordmark } from '@/components/brand/wordmark';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import { getAuthContext } from '@/lib/auth/session';
import { capabilityReport, isDemoMode } from '@/lib/config/env';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Which sign-in path is offered depends on runtime environment, and with no
 * session cookie to read there is no dynamic API to force that on its own.
 * Without this the page prerenders against build-time env — so a build made
 * without DEMO_MODE serves "not configured" for ever, even when started with
 * `npm run start:demo`.
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await getAuthContext();
  if (auth) redirect('/today');

  const busy = (await searchParams).busy === '1';
  const demo = isDemoMode();
  const supabaseReady = capabilityReport().find((c) => c.key === 'supabase')?.status === 'ready';

  return (
    <main
      id="main"
      className="flex min-h-dvh items-center justify-center bg-[var(--bg)] px-4 py-10"
    >
      <div className="w-full max-w-md">
        <div className="mb-7 flex justify-center">
          <Wordmark />
        </div>

        <Card>
          <CardContent className="pt-5">
            <h1 className="font-serif text-xl font-semibold">
              {demo ? 'Demo workspace' : 'Sign in'}
            </h1>
            <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
              {demo
                ? 'Explore the full product against a fictional dataset. No credentials, no external calls, nothing real.'
                : 'TipTop Copilot is an internal tool. Access is limited to members of the TipTop organization.'}
            </p>

            {busy ? (
              <Notice tone="warn" className="mt-4">
                <p className="font-medium">The demo is busy right now.</p>
                <p className="mt-1 text-[var(--fg-muted)]">
                  Too many workspaces were opened in the last minute. Wait about a minute and try
                  again — nothing is wrong and nothing was lost.
                </p>
              </Notice>
            ) : null}

            {demo ? (
              <>
                <form action={enterDemoAction} className="mt-6">
                  <Button type="submit" variant="primary" size="lg" className="w-full">
                    Enter demo workspace
                  </Button>
                </form>
                <p className="mt-4 text-xs text-[var(--fg-subtle)]">
                  Signed in as Nick Tippmann (demo). Every company, person, email and number in this
                  workspace is invented for demonstration.
                </p>
              </>
            ) : (
              <div className="mt-6 space-y-4">
                {supabaseReady ? (
                  <Button asChild variant="primary" size="lg" className="w-full">
                    <a href="/api/auth/google">Continue with Google</a>
                  </Button>
                ) : (
                  <Notice tone="warn">
                    <p className="font-medium">Authentication is not configured.</p>
                    <p className="mt-1 text-[var(--fg-muted)]">
                      Set the Supabase environment variables, or run with{' '}
                      <code className="rounded bg-[var(--bg-sunken)] px-1 py-0.5 font-mono text-[11px]">
                        DEMO_MODE=true
                      </code>{' '}
                      to explore the product offline. The{' '}
                      <a className="underline" href="/diagnostics">
                        diagnostics page
                      </a>{' '}
                      lists exactly what is missing.
                    </p>
                  </Notice>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <p className="mt-5 text-center text-xs text-[var(--fg-subtle)]">
          Read-only mailbox access. This product drafts email; it never sends it.
        </p>
      </div>
    </main>
  );
}

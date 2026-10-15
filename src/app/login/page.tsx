import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { enterDemoAction } from '@/app/actions/session';
import { GoldFiligree } from '@/components/brand/gold-filigree';
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

/**
 * What the sign-in routes redirect back with. Each says what happened and what
 * to do; none names a configuration value that would tell an anonymous visitor
 * anything about the deployment.
 */
const AUTH_ERRORS: Record<string, { title: string; detail: string }> = {
  domain: {
    title: 'That account is not permitted.',
    detail:
      'Access is limited to TipTop accounts. You were signed out again. If you believe this is wrong, ask an administrator to check the permitted domains.',
  },
  denied: {
    title: 'Sign-in was cancelled.',
    detail: 'You declined at the Google consent screen, or the provider refused. Try again.',
  },
  not_configured: {
    title: 'Authentication is not configured.',
    detail: 'This deployment has no identity provider set up yet. An administrator needs to.',
  },
  no_code: {
    title: 'Sign-in did not complete.',
    detail: 'Google did not return an authorization code. Start again from this page.',
  },
  exchange: {
    title: 'Sign-in could not be completed.',
    detail: 'The authorization code could not be exchanged for a session. Try again.',
  },
  provider: {
    title: 'Could not reach Google.',
    detail: 'The sign-in provider did not respond. Try again in a moment.',
  },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await getAuthContext();
  if (auth) redirect('/today');

  const params = await searchParams;
  const busy = params.busy === '1';
  const authError = typeof params.error === 'string' ? params.error : null;
  const demo = isDemoMode();

  // Both halves, not just the anon key. Signing in against a project with no
  // service-role key would succeed and then fail on the first data read, which
  // is a worse experience than not offering the button.
  const report = capabilityReport();
  const supabaseReady =
    report.find((c) => c.key === 'supabase')?.status === 'ready' &&
    report.find((c) => c.key === 'supabase_service')?.status === 'ready';

  return (
    <main
      id="main"
      className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-[var(--bg)] bg-[image:var(--spotlight)] px-4 py-10"
    >
      {/* A forest-green band across the top in both themes, with the gold
          line art in it and a gold hairline for an edge, like the page-header
          band inside the app. It ends just above the middle of the page, so
          the column (centred on that middle) always has the wordmark on the
          band and the card overlapping its edge, whatever the viewport. */}
      <div
        aria-hidden="true"
        className="dark absolute inset-x-0 top-0 isolate -z-10 h-[calc(50%-2.5rem)] bg-[var(--bg-band)] after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[var(--gold-rule)]"
      >
        <GoldFiligree variant="band" />
      </div>
      <div className="w-full max-w-md">
        {/* On the band, so it takes the band's (dark) tokens: cream type and
            the bright brand green for the mark. */}
        <div className="dark mb-7 flex justify-center text-[var(--fg)]">
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

            {authError ? (
              <Notice tone="warn" className="mt-4">
                <p className="font-medium">{AUTH_ERRORS[authError]?.title ?? 'Sign-in failed.'}</p>
                <p className="mt-1 text-[var(--fg-muted)]">
                  {AUTH_ERRORS[authError]?.detail ??
                    'Something went wrong completing sign-in. Try again.'}
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

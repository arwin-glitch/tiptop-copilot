import type { Metadata } from 'next';
import { AuthShell } from '@/components/desktop/auth-shell';

export const metadata: Metadata = {
  title: 'Desktop sign-in',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/** Fixed copy per outcome: the query only ever picks one of these, never says what to show. */
const RESULTS: Record<string, { title: string; detail: string }> = {
  cancelled: {
    title: 'Sign-in stopped',
    detail: 'Nobody was signed in. You can close this tab.',
  },
  too_late: {
    title: 'This sign-in already finished',
    detail:
      'The desktop app is already signed in with it. If you didn’t just sign in to the app yourself, tell the TipTop team right away.',
  },
  expired: {
    title: 'This sign-in link has expired',
    detail:
      'Go back to the TipTop Kraken app and click Sign in with Google again. You can close this tab.',
  },
  busy: { title: 'Too many tries', detail: 'Wait a minute, then try again from the app.' },
  unavailable: {
    title: 'Sign-in isn’t available right now',
    detail: 'Try again in a few minutes.',
  },
};

const FALLBACK = {
  title: 'Something went wrong',
  detail: 'Go back to the app and click Sign in with Google again.',
};

/** Where "I didn't start this" lands, in the system browser. */
export default async function DesktopDonePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { result } = await searchParams;
  const copy =
    (typeof result === 'string' && Object.hasOwn(RESULTS, result) && RESULTS[result]) || FALLBACK;
  return (
    <AuthShell title={copy.title}>
      <p className="mt-1.5 text-sm text-[var(--fg-muted)]">{copy.detail}</p>
    </AuthShell>
  );
}

import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth/session';

/**
 * Full-screen pages for signed-in members, outside the app shell (no rail,
 * no tab bar, no Ask Arwin launcher): Events Studio (/events/[id]/studio).
 * Same root layout, theme and session as the rest of Kraken; the route
 * group only leaves the shell out. Each page still checks its own access.
 */
export default async function FocusLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');
  return <div className="min-h-dvh">{children}</div>;
}

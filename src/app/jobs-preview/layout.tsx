import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth/session';
import '@/components/jobs-board/board.css';

/**
 * Kraken's preview of the public job board: the same pages, read while the
 * board is still switched off, for people signed in to Kraken only. The
 * proxy only checks that a session cookie is present, so the layout and every
 * page check the session itself and send anyone else to /login.
 *
 * The metadata is fixed text: no board data is ever read for it. (A page's
 * generateMetadata runs apart from its body, so reading the board there
 * would hand the staged roles to anyone with a made-up session cookie.)
 */
export const metadata: Metadata = {
  title: { absolute: 'Job board preview · TipTop Kraken' },
  description: 'A signed-in preview of the public job board.',
  robots: { index: false, follow: false, nocache: true },
};

export default async function JobsBoardPreviewLayout({ children }: { children: ReactNode }) {
  if (!(await getAuthContext())) redirect('/login');
  return children;
}

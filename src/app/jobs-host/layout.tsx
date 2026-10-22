import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { boardHostOrigin } from '@/lib/jobs-board/config';
import '@/components/jobs-board/board.css';

/**
 * The public job board at the root of the board's own host (jobs.tiptop.vc), which the proxy rewrites here.
 * Public: no session needed (proxy.ts), and indexed by search engines, unlike
 * the rest of Copilot. The pages are in components/jobs-board/pages.tsx.
 */
export const metadata: Metadata = {
  metadataBase: new URL(boardHostOrigin()),
  applicationName: 'TipTop VC Jobs',
  robots: { index: true, follow: true },
  appleWebApp: { capable: false, title: 'TipTop Jobs' },
};

export default function JobsBoardLayout({ children }: { children: ReactNode }) {
  return children;
}

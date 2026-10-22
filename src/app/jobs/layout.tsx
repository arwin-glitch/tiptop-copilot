import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { appOrigin } from '@/lib/jobs-board/config';
import '@/components/jobs-board/board.css';

/**
 * The public job board at Copilot's own host (/jobs).
 * Public: no session needed (proxy.ts), and indexed by search engines, unlike
 * the rest of Copilot. The pages are in components/jobs-board/pages.tsx.
 */
export const metadata: Metadata = {
  metadataBase: new URL(appOrigin()),
  applicationName: 'TipTop VC Jobs',
  robots: { index: true, follow: true },
  appleWebApp: { capable: false, title: 'TipTop Jobs' },
};

export default function JobsBoardLayout({ children }: { children: ReactNode }) {
  return children;
}

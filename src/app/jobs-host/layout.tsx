import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { boardHostOrigin } from '@/lib/jobs-board/config';
import { BOARD_LAYOUT_METADATA, BOARD_VIEWPORT } from '@/components/jobs-board/metadata';
import '@/components/jobs-board/board.css';

/**
 * The public job board at the root of the board's own host (jobs.tiptop.vc), which the proxy rewrites here.
 * Public: no session needed (proxy.ts), and indexed by search engines, unlike
 * the rest of Copilot. The pages are in components/jobs-board/pages.tsx.
 *
 * The board's own fallback title, description and link-preview text replace
 * Copilot's root ones, so no board address (a closed role, a 404) ever
 * unfurls as "TipTop Copilot". Each page sets its own robots; the fallback
 * here is noindex, for error pages.
 */
export const metadata: Metadata = {
  ...BOARD_LAYOUT_METADATA,
  metadataBase: new URL(boardHostOrigin()),
};

export const viewport: Viewport = BOARD_VIEWPORT;

export default function JobsBoardLayout({ children }: { children: ReactNode }) {
  return children;
}

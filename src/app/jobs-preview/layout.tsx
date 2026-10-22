import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@/components/jobs-board/board.css';

/**
 * Copilot's preview of the public job board: the same pages, read while the
 * board is still switched off, for people signed in to Copilot only (the
 * proxy asks for a session, and every page checks it too). Never indexed.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function JobsBoardPreviewLayout({ children }: { children: ReactNode }) {
  return children;
}

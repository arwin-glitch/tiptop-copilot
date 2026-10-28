import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { homePath, type PublicBoard } from '@/lib/jobs-board/public';
import { boardFontClasses } from './fonts';
import { TipTopMark } from './parts';

/**
 * The board's frame on every page: the TipTop header, the Jobs | Companies
 * tabs with live counts (like the Perks directory's tab bar), and the footer.
 */
export function BoardShell({
  base,
  board,
  active,
  preview = false,
  children,
}: {
  base: string;
  board: PublicBoard | null;
  active: 'jobs' | 'companies' | null;
  preview?: boolean;
  children: ReactNode;
}) {
  const style = board ? ({ '--jb-accent': board.accent } as CSSProperties) : undefined;
  return (
    <div className={`jb-root ${boardFontClasses}`} style={style}>
      {preview ? (
        <p className="jb-banner" role="status">
          Preview: only people signed in to Kraken see this. The public board is switched off, so
          visitors see &ldquo;coming soon&rdquo;.
        </p>
      ) : null}
      <div className="jb-atmosphere" aria-hidden="true" />
      <header className="jb-header">
        <div className="jb-wrap jb-header-inner">
          <Link href={homePath(base)} className="jb-brand" aria-label="TipTop VC jobs home">
            <TipTopMark />
            <span className="jb-brand-word">
              TipTop <span>VC</span>
            </span>
          </Link>
          <span className="jb-tag">Jobs</span>
          <a
            href="https://www.tiptop.vc"
            className="jb-btn jb-btn-ghost jb-btn-small jb-header-cta"
          >
            tiptop.vc
          </a>
        </div>
      </header>
      {board ? (
        <nav className="jb-tabs" aria-label="Job board sections">
          <div className="jb-wrap jb-tabs-inner">
            <Link href={homePath(base)} aria-current={active === 'jobs' ? 'page' : undefined}>
              Open roles <span className="jb-tab-count">{board.jobs.length}</span>
            </Link>
            <Link
              href={`${base}/companies`}
              aria-current={active === 'companies' ? 'page' : undefined}
            >
              Companies <span className="jb-tab-count">{board.companies.length}</span>
            </Link>
          </div>
        </nav>
      ) : null}
      <main id="main" className="jb-main">
        {children}
      </main>
      <footer className="jb-footer">
        <div className="jb-wrap jb-footer-inner">
          <div>
            <a href="https://www.tiptop.vc" className="jb-brand" aria-label="TipTop VC">
              <TipTopMark />
              <span className="jb-brand-word">
                TipTop <span>VC</span>
              </span>
            </a>
            <p>
              Open roles at the companies TipTop VC backs. Every application goes straight to the
              company, on its own careers page.
            </p>
          </div>
          <div>
            <nav aria-label="TipTop VC">
              <a href="https://www.tiptop.vc">tiptop.vc</a>
              <a href="https://perks.tiptop.vc">Founder perks</a>
              <Link href={`${base}/companies`}>Companies</Link>
            </nav>
            <small>© {new Date().getUTCFullYear()} TipTop VC</small>
          </div>
        </div>
      </footer>
    </div>
  );
}

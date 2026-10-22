import Link from 'next/link';
import { homePath } from '@/lib/jobs-board/public';
import { TipTopMark } from './parts';
import { BoardShell } from './shell';

/**
 * A board address with nothing behind it: a company not on the board, or a
 * mistyped link. (A closed role at a company still on the board gets its own
 * page, with that company's open roles: ClosedRole in pages.tsx.)
 */
export function BoardNotFound({ base }: { base: string }) {
  return (
    <BoardShell base={base} board={null} active={null}>
      <section className="jb-wrap jb-soon">
        <div>
          <TipTopMark />
          <p className="jb-eyebrow">TipTop VC · Portfolio jobs</p>
          <h1>This page isn&rsquo;t on the board.</h1>
          <p>
            The company may have left the board, or the link is mistyped. Every open role is on the
            board.
          </p>
          <Link className="jb-btn jb-btn-primary" href={homePath(base)}>
            See open roles
          </Link>
        </div>
      </section>
    </BoardShell>
  );
}

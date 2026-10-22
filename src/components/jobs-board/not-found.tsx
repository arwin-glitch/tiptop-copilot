import Link from 'next/link';
import { homePath } from '@/lib/jobs-board/public';
import { TipTopMark } from './parts';
import { BoardShell } from './shell';

/** A board address with no role or company behind it (often a role that has closed). */
export function BoardNotFound({ base }: { base: string }) {
  return (
    <BoardShell base={base} board={null} active={null}>
      <section className="jb-wrap jb-soon">
        <div>
          <TipTopMark />
          <p className="jb-eyebrow">TipTop VC · Portfolio jobs</p>
          <h1>This role is not open any more.</h1>
          <p>
            It may have been filled, or the link is mistyped. Every role that is open is on the
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

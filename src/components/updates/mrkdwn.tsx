import type { ReactNode } from 'react';
import { cn } from '@/lib/util/cn';
import { safeHref } from '@/lib/updates/mrkdwn';
import type { Block, Seg } from '@/lib/updates/types';

/**
 * Parsed Slack text as elements. Text is only ever a React child — never
 * markup — and a link is rendered only when its href passes the whitelist
 * again here, so a segment built anywhere else still cannot carry a
 * `javascript:` URL onto the page.
 */

function SegView({ seg }: { seg: Seg }) {
  let node: ReactNode = seg.text;
  const href = seg.href ? safeHref(seg.href) : null;
  if (href) {
    node = (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-[var(--accent)] underline-offset-2 hover:underline"
      >
        {node}
      </a>
    );
  }
  if (seg.code) node = <code className="font-mono text-[0.92em]">{node}</code>;
  if (seg.strike) node = <s>{node}</s>;
  if (seg.italic) node = <em>{node}</em>;
  if (seg.bold) node = <strong className="font-semibold">{node}</strong>;
  return <>{node}</>;
}

export function Mrkdwn({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((seg, i) => (
        <SegView key={i} seg={seg} />
      ))}
    </>
  );
}

type Run =
  | { kind: 'bullets'; items: Extract<Block, { type: 'bullet' }>[] }
  | { kind: 'numbered'; items: Extract<Block, { type: 'numbered' }>[] }
  | { kind: 'single'; block: Extract<Block, { type: 'para' | 'label' }> };

function runs(blocks: Block[]): Run[] {
  const out: Run[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (block.type === 'bullet') {
      if (last?.kind === 'bullets') last.items.push(block);
      else out.push({ kind: 'bullets', items: [block] });
    } else if (block.type === 'numbered') {
      if (last?.kind === 'numbered') last.items.push(block);
      else out.push({ kind: 'numbered', items: [block] });
    } else {
      out.push({ kind: 'single', block });
    }
  }
  return out;
}

/** Clamping a <li> itself would drop its list marker, so the clamp goes inside. */
function Clamped({ className, children }: { className?: string; children: ReactNode }) {
  return className ? <span className={className}>{children}</span> : <>{children}</>;
}

const CLAMP = { 1: 'line-clamp-1', 2: 'line-clamp-2', 3: 'line-clamp-3' } as const;

/** `clamp` limits each item (and each paragraph) to that many lines. */
export function Blocks({
  blocks,
  clamp,
  className,
}: {
  blocks: Block[];
  clamp?: boolean | 1 | 2 | 3;
  className?: string;
}) {
  const item = clamp ? CLAMP[clamp === true ? 2 : clamp] : undefined;
  return (
    <div className={cn('space-y-1.5 text-sm leading-relaxed [overflow-wrap:anywhere]', className)}>
      {runs(blocks).map((run, i) => {
        if (run.kind === 'bullets') {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5 marker:text-[var(--fg-subtle)]">
              {run.items.map((b, j) => (
                <li key={j} className={cn(b.depth === 1 && 'ml-4 list-[circle]')}>
                  <Clamped className={item}>
                    <Mrkdwn segs={b.segs} />
                  </Clamped>
                </li>
              ))}
            </ul>
          );
        }
        if (run.kind === 'numbered') {
          return (
            <ol
              key={i}
              start={run.items[0]?.n ?? 1}
              className="list-decimal space-y-1 pl-5 marker:text-[var(--fg-subtle)]"
            >
              {run.items.map((b, j) => (
                <li key={j} value={b.n}>
                  <Clamped className={item}>
                    <Mrkdwn segs={b.segs} />
                  </Clamped>
                </li>
              ))}
            </ol>
          );
        }
        const b = run.block;
        if (b.type === 'label') {
          return (
            <p
              key={i}
              className="text-micro pt-1 font-medium tracking-wider text-[var(--fg-subtle)] uppercase"
            >
              <Mrkdwn segs={b.segs} />
            </p>
          );
        }
        return (
          <p key={i} className={item}>
            {b.lines.map((line, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                <Mrkdwn segs={line} />
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

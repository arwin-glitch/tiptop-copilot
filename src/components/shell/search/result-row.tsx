'use client';

import * as React from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { cn } from '@/lib/util/cn';
import {
  faviconUrl,
  highlightSegments,
  initials,
  isCompanyKind,
  logoDomainOf,
  type Result,
} from './palette-model';

/** Text with the query's words in bold, as React nodes (never HTML). */
export function Highlight({ text, words }: { text: string; words: readonly string[] }) {
  return (
    <>
      {highlightSegments(text, words).map((s, i) =>
        s.match ? (
          <strong key={i} className="font-semibold text-[var(--fg)]">
            {s.text}
          </strong>
        ) : (
          <React.Fragment key={i}>{s.text}</React.Fragment>
        ),
      )}
    </>
  );
}

/**
 * A company's favicon (from a validated domain) or initials; people are
 * always initials in a round avatar.
 */
export function Logo({
  label,
  domain,
  round,
  size = 'sm',
  text,
}: {
  label: string;
  domain: string | null;
  round: boolean;
  size?: 'sm' | 'lg';
  text?: string | null;
}) {
  const src = faviconUrl(domain);
  const [failed, setFailed] = React.useState<string | null>(null);
  const box = cn(
    'flex shrink-0 items-center justify-center overflow-hidden font-semibold',
    size === 'lg' ? 'size-12 text-base' : 'text-micro size-7',
    round ? 'rounded-full' : size === 'lg' ? 'rounded-lg' : 'rounded-md',
  );
  if (src && failed !== src) {
    return (
      <span aria-hidden className={cn(box, 'border border-[var(--border)] bg-white')}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a 64px favicon, not worth the optimiser */}
        <img
          src={src}
          alt=""
          width={size === 'lg' ? 32 : 18}
          height={size === 'lg' ? 32 : 18}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
          className={size === 'lg' ? 'size-8' : 'size-[18px]'}
        />
      </span>
    );
  }
  return (
    <span aria-hidden className={cn(box, 'bg-[var(--accent-soft)] text-[var(--accent)]')}>
      {(text ?? initials(label)).slice(0, 2).toUpperCase()}
    </span>
  );
}

export function ResultOption({
  id,
  result,
  kindLabel,
  words,
  active,
  onHover,
  onPick,
  onForget,
}: {
  id?: string;
  result: Result;
  kindLabel: string;
  words: readonly string[];
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  onForget?: () => void;
}) {
  const ref = React.useRef<HTMLLIElement>(null);
  React.useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const harmonic = result.kind === 'harmonic_person' || result.kind === 'harmonic_company';
  const tag = harmonic ? (result.kind === 'harmonic_person' ? 'Person' : 'Company') : kindLabel;
  return (
    <li ref={ref} id={id} role="option" aria-selected={active} className="group relative">
      <button
        type="button"
        tabIndex={-1}
        onMouseEnter={onHover}
        onClick={onPick}
        className={cn(
          'relative flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left',
          // Focus stays in the input, so this row is the only sign of what
          // Enter opens. A tint alone is about 1.2:1 against the dialog; the
          // inset ring and the gold rule each clear 3:1.
          active
            ? 'bg-[var(--bg-hover)] shadow-[inset_0_0_0_1px_var(--border-control)] before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-[var(--gold)]'
            : 'hover:bg-[var(--bg-hover)]',
          'pr-9',
        )}
      >
        <Logo
          label={result.label}
          domain={logoDomainOf(result)}
          round={!isCompanyKind(result.kind) && result.kind !== 'crm_list'}
        />
        <span className="flex min-w-0 flex-1 items-baseline gap-1 truncate text-sm text-[var(--fg-muted)]">
          <span className="truncate text-[var(--fg)]">
            <Highlight text={result.label} words={words} />
          </span>
          {result.sub ? (
            <span className="hidden min-w-0 truncate sm:inline">
              {' • '}
              <Highlight text={result.sub} words={words} />
            </span>
          ) : null}
          {tag ? (
            <span className="shrink-0 text-xs text-[var(--fg-subtle)]">{` • ${tag}`}</span>
          ) : null}
        </span>
        {harmonic ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="text-micro rounded-full border border-[var(--gold)] px-1.5 py-px font-medium text-[var(--label-gold)]">
              Harmonic
            </span>
            <span className="text-micro hidden text-[var(--fg-subtle)] sm:inline">Not met yet</span>
          </span>
        ) : null}
      </button>
      {onForget ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={onForget}
          aria-label={`Remove ${result.label} from recent searches`}
          className="absolute top-1/2 right-2 hidden -translate-y-1/2 rounded p-1 text-[var(--fg-subtle)] group-hover:block hover:bg-[var(--bg-raised)] hover:text-[var(--fg)] focus-visible:block"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : (
        <ArrowUpRight
          aria-hidden
          className={cn(
            'pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-[var(--fg-muted)]',
            active ? 'block' : 'hidden group-hover:block',
          )}
        />
      )}
    </li>
  );
}

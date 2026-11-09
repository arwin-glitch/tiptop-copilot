'use client';

import * as React from 'react';
import { ArrowUpRight, Clock, Keyboard, Search, Sparkles } from 'lucide-react';
import { formatContactDate } from '@/components/network/contact-status-tag';
import { CONTACT_STATUS_LABELS, type ContactStatus } from '@/lib/network/contact-status';
import type { SearchPreview } from '@/lib/services/search-preview';
import { cn } from '@/lib/util/cn';
import {
  cleanDomain,
  isCompanyKind,
  isHarmonicPreview,
  logoDomainOf,
  normalizePreviewCard,
  previewCacheKey,
  previewKeyOf,
  type PreviewCard,
  type PreviewKey,
  type Result,
  type Tone,
} from './palette-model';
import { Logo } from './result-row';

/* ---------------------------------------------------------------- loading */

/**
 * Previews for this palette session, per kind+key (cleared when it closes).
 */
export type PreviewCache = Map<string, PreviewCard | 'error'>;

const STATUS_TONE: Record<ContactStatus, Tone> = {
  recent: 'ok',
  losing: 'warn',
  lost: 'bad',
  never: 'neutral',
};

/** The older /api/search/preview?id= answer, drawn as a card. */
function fromLegacy(p: SearchPreview, result: Result): PreviewCard {
  const company = p.kind === 'company' || isCompanyKind(result.kind);
  const list = p.lists[0];
  return {
    kind: p.kind,
    title: p.name,
    subtitle: [p.sub, p.industry ?? p.title].filter(Boolean).join(' • ') || null,
    logoDomain: company ? cleanDomain(p.sub) : null,
    avatarText: null,
    status: p.contact
      ? { label: CONTACT_STATUS_LABELS[p.contact.status], tone: STATUS_TONE[p.contact.status] }
      : null,
    description: list
      ? `${list.name}${p.listCount > 1 ? ` · +${p.listCount - 1} more` : ''}`
      : null,
    counts: [
      { label: 'Lists & Opportunities', value: p.listCount },
      { label: 'Notes', value: p.counts.notesCapped ? `${p.counts.notes}+` : p.counts.notes },
      { label: 'Connections', value: p.counts.connections },
      { label: 'Reminders', value: p.counts.reminders },
    ],
    lastContact: p.contact?.lastContactAt
      ? { at: p.contact.lastContactAt, text: p.contact.lastTouchText }
      : null,
    facts: (
      [
        ['Owner', p.owner],
        ['Status', p.stage],
        ['Amount', p.amount],
      ] as const
    ).flatMap(([label, value]) => (value ? [{ label, value }] : [])),
    links: [],
    openHref: p.href,
    source: 'kraken',
  };
}

async function loadCard(
  key: PreviewKey,
  result: Result,
  signal: AbortSignal,
): Promise<PreviewCard | 'error'> {
  try {
    const res = await fetch(
      `/api/search/preview?kind=${encodeURIComponent(key.kind)}&key=${encodeURIComponent(key.key)}`,
      { signal },
    );
    if (res.ok) {
      const card = normalizePreviewCard(await res.json().catch(() => null));
      if (card) return card;
    }
  } catch (e) {
    if (signal.aborted) throw e;
  }
  // The older endpoint, by record id, while the new one is not there yet.
  if (result.recordId) {
    try {
      const res = await fetch(`/api/search/preview?id=${encodeURIComponent(result.recordId)}`, {
        signal,
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        preview?: SearchPreview;
      } | null;
      if (body?.ok && body.preview && typeof body.preview.name === 'string') {
        return fromLegacy(body.preview, result);
      }
    } catch (e) {
      if (signal.aborted) throw e;
    }
  }
  return 'error';
}

function usePreviewCard(result: Result, cache: PreviewCache) {
  const key = previewKeyOf(result);
  const id = key ? previewCacheKey(key) : null;
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!key || !id || cache.has(id)) return;
    const controller = new AbortController();
    // Arrowing down a list should not fire a request per row passed; a
    // Harmonic preview spends a free look-up, so it waits for a settled row.
    const timer = window.setTimeout(
      async () => {
        try {
          const value = await loadCard(key, result, controller.signal);
          // Failures are kept for this session too: a Harmonic retry would
          // spend another look-up, and the panel says to press Enter instead.
          cache.set(id, value);
          if (cache.size > 200) cache.delete(cache.keys().next().value as string);
          setTick((t) => t + 1);
        } catch {
          // Moved on to another row.
        }
      },
      isHarmonicPreview(key) ? 400 : 120,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // `result` is read once per key; the key decides what loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cache]);
  return { key, value: id ? (cache.get(id) ?? null) : null };
}

/* ---------------------------------------------------------------- panel */

const PANEL =
  'hidden max-h-[56dvh] w-80 shrink-0 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg-raised)] p-4 min-[720px]:block';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-[var(--ok-soft)] text-[var(--ok)]',
  warn: 'bg-[var(--warn-soft)] text-[var(--warn)]',
  bad: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  neutral: 'bg-[var(--neutral-soft)] text-[var(--fg-muted)]',
};

const SOURCE_LABEL: Record<string, string> = {
  kraken: 'Kraken',
  affinity: 'Affinity',
  mail: 'Mail',
  harmonic: 'Harmonic',
};

export function PreviewPanel({
  result,
  kindLabel,
  cache,
  onOpen,
}: {
  result: Result;
  kindLabel: string;
  cache: PreviewCache;
  onOpen: () => void;
}) {
  const { key, value } = usePreviewCard(result, cache);
  const card = value && value !== 'error' ? value : null;
  const company = isCompanyKind(result.kind);
  const domain = card ? card.logoDomain : logoDomainOf(result);
  const external = result.kind === 'lookup';
  return (
    <aside aria-label="Preview" data-testid="search-preview" className={PANEL}>
      <div className="flex items-start justify-between gap-2">
        <Logo
          label={card?.title ?? result.label}
          domain={domain}
          round={!company && card?.kind !== 'company'}
          size="lg"
          text={card?.avatarText}
        />
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${result.label}`}
          className="shrink-0 rounded-md border border-[var(--border)] p-1.5 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
        >
          <ArrowUpRight className="size-3.5" aria-hidden />
        </button>
      </div>
      <p className="mt-3 font-serif text-lg leading-tight font-semibold break-words">
        {card?.title ?? result.label}
      </p>
      {domain ? (
        <a
          href={`https://${domain}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-mini mt-0.5 block truncate text-[var(--accent)] hover:underline"
        >
          {domain}
        </a>
      ) : null}
      <p className="text-mini mt-0.5 text-[var(--fg-muted)]">
        {card?.subtitle ?? [kindLabel, result.sub].filter(Boolean).join(' • ')}
      </p>
      {card?.status ? (
        <span
          className={cn(
            'text-micro mt-2 inline-block rounded-full px-2 py-0.5 font-medium',
            TONE_CLASS[card.status.tone],
          )}
        >
          {card.status.label}
        </span>
      ) : null}

      {!key ? (
        <div className="mt-4 space-y-3 text-xs">
          <p className="text-[var(--fg-subtle)]">{kindLabel}</p>
          <button
            type="button"
            onClick={onOpen}
            className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]"
          >
            {external ? 'Open in a new tab' : 'Open'}
          </button>
          <p className="text-[var(--fg-subtle)]">Or press Enter.</p>
        </div>
      ) : value === null ? (
        <div className="mt-4 space-y-2" aria-hidden>
          <div className="h-3 w-full animate-pulse rounded bg-[var(--bg-hover)]" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-[var(--bg-hover)]" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--bg-hover)]" />
          {isHarmonicPreview(key) ? (
            <p className="text-micro pt-1 text-[var(--fg-subtle)]">Asking Harmonic…</p>
          ) : null}
        </div>
      ) : value === 'error' ? (
        <p className="mt-3 text-xs text-[var(--fg-subtle)]">
          The preview could not be loaded. Press Enter to open the page.
        </p>
      ) : (
        <CardBody card={value} />
      )}
    </aside>
  );
}

function CardBody({ card }: { card: PreviewCard }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let when: string | null = null;
  if (card.lastContact?.at) {
    try {
      when = formatContactDate(card.lastContact.at, timezone, true);
    } catch {
      when = card.lastContact.at;
    }
  }
  return (
    <div className="mt-3 space-y-4 text-xs">
      {card.description ? (
        <p className="line-clamp-3 text-[var(--fg-muted)]">{card.description}</p>
      ) : null}
      {card.counts.length > 0 ? (
        <ul aria-label="Counts" className="space-y-1.5">
          {card.counts.map((c) => (
            <li key={c.label} className="flex items-center justify-between gap-2">
              <span>{c.label}</span>
              <span className="tabular text-micro flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--bg-hover)] px-1.5 font-semibold">
                {c.value}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {card.facts.length > 0 ? (
        <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1.5">
          {card.facts.map((f) => (
            <React.Fragment key={f.label}>
              <dt className="text-[var(--fg-subtle)]">{f.label}</dt>
              <dd className="truncate">{f.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
      <div>
        <p className="text-micro font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
          Last contact
        </p>
        {card.lastContact ? (
          <p className="mt-1">
            {when ? <span className="font-medium">{when}</span> : null}
            {card.lastContact.text ? (
              <span className="line-clamp-2 block text-[var(--fg-muted)]">
                {card.lastContact.text}
              </span>
            ) : null}
          </p>
        ) : (
          <p className="mt-1 text-[var(--fg-subtle)]">No email or meeting on record.</p>
        )}
      </div>
      {card.links.length > 0 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {card.links.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className="text-[var(--accent)] hover:underline"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {card.source && SOURCE_LABEL[card.source] ? (
        <p className="text-micro text-[var(--fg-subtle)]">From {SOURCE_LABEL[card.source]}</p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- tips */

/** What the right side shows when no row is highlighted: never an empty box. */
export function SuggestionsPanel({
  recents,
  onPick,
  harmonicLeft,
  noMatches,
}: {
  recents: Result[];
  onPick: (r: Result) => void;
  harmonicLeft: number | null;
  noMatches: boolean;
}) {
  return (
    <aside aria-label="Search tips" data-testid="search-tips" className={PANEL}>
      <p className="text-micro font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
        {noMatches ? 'Nothing here yet' : 'Search tips'}
      </p>
      <ul className="mt-2 space-y-2.5 text-xs text-[var(--fg-muted)]">
        <li className="flex gap-2">
          <Search className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Type a name, company, domain or email.
        </li>
        <li className="flex gap-2">
          <Keyboard className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Use ↑ ↓ to preview, Enter to open, Tab to switch tabs.
        </li>
        <li className="flex gap-2">
          <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Nobody met yet? Pause on 3+ letters and Harmonic is asked once
          {harmonicLeft !== null ? ` (${harmonicLeft} look-ups left today)` : ''}.
        </li>
      </ul>
      {recents.length > 0 ? (
        <>
          <p className="text-micro mt-5 flex items-center gap-1.5 font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
            <Clock className="size-3" aria-hidden />
            Recent searches
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {recents.slice(0, 5).map((r) => (
              <li key={r.href}>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => onPick(r)}
                  className="w-full truncate rounded px-1.5 py-1 text-left text-xs hover:bg-[var(--bg-hover)]"
                >
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </aside>
  );
}

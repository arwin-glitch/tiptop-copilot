'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Input } from '@/components/ui/form';
import { DAILY_CAP } from '@/lib/campaigns/limits';
import type { ManifestRow, ManifestSummary } from '@/lib/campaigns/manifest';
import { campaignCall } from './campaign-api';

interface Manifest {
  version: string;
  extras: boolean;
  tracking: boolean;
  unsubscribe: boolean;
  summary: ManifestSummary;
  line: string;
  warnings: string[];
  rows: ManifestRow[];
}

/** Rows a page of the table shows: a list to check, not a page to scroll. */
const PAGE = 10;

const matches = (r: ManifestRow, q: string) =>
  [r.to, r.name ?? '', r.photo?.name ?? '', ...r.cc, ...r.bcc, ...r.flags.map((f) => f.text)]
    .join(' ')
    .toLowerCase()
    .includes(q);

/** A row's CC (theirs marked) and BCC (the first-only sample marked). */
function CopyCells({ row: r }: { row: ManifestRow }) {
  const none = <span className="text-[var(--fg-subtle)]">none</span>;
  return (
    <>
      <td className="px-3 py-2 break-all">
        {r.cc.length
          ? r.cc.map((e) => (
              <span key={e} className="block">
                {e}
                {r.personalCc.includes(e) ? (
                  <span className="text-[var(--fg-subtle)]"> (theirs)</span>
                ) : null}
              </span>
            ))
          : none}
      </td>
      <td className="px-3 py-2 break-all">
        {r.bcc.length ? (
          <>
            {r.bcc.map((e) => (
              <span key={e} className="block">
                {e}
              </span>
            ))}
            {r.bccSample ? (
              <span className="block text-[var(--fg-subtle)]">first email only</span>
            ) : null}
          </>
        ) : (
          none
        )}
      </td>
    </>
  );
}

/**
 * The dry run on the review screen: every person still to be sent to, what
 * their email carries (photo, shared attachments, CC, BCC) and anything wrong
 * with it, in send order, a page at a time and searchable, with the same as a
 * CSV. Read from the server, like the rest of the review; read again whenever
 * the review is.
 */
export function WhoGetsWhat({ campaignId, version }: { campaignId: string; version: string }) {
  const [manifest, setManifest] = React.useState<Manifest | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [page, setPage] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    void campaignCall<{ manifest: Manifest }>(`/api/campaigns/${campaignId}/manifest`).then((r) => {
      if (!live) return;
      if (r.ok) {
        setManifest(r.data.manifest);
        setError(null);
      } else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [campaignId, version]);

  const q = query.trim().toLowerCase();
  const rows = React.useMemo(
    () => (manifest ? (q ? manifest.rows.filter((r) => matches(r, q)) : manifest.rows) : []),
    [manifest, q],
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * PAGE, current * PAGE + PAGE);

  const heading = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="who-gets-what-heading" className="text-sm font-medium">
        Who gets what
      </h3>
      {manifest?.rows.length ? (
        <a
          href={`/api/campaigns/${campaignId}/manifest?format=csv`}
          download="who-gets-what.csv"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <Download aria-hidden="true" />
          Download CSV
        </a>
      ) : null}
    </div>
  );

  if (error || !manifest) {
    return (
      <section aria-labelledby="who-gets-what-heading" className="space-y-2">
        {heading}
        <p className="text-sm text-[var(--fg-muted)]">{error ?? 'Reading who gets what…'}</p>
      </section>
    );
  }

  const { summary } = manifest;
  const copies = summary.effectiveTotal - summary.recipients;
  const copying = summary.cc.length > 0 || summary.bcc.length > 0 || summary.personalCc > 0;
  // Photos and copies not set up yet (their migration): none of it is shown.
  const extras = manifest.extras;
  const people = `${summary.recipients} ${summary.recipients === 1 ? 'person' : 'people'}`;
  return (
    <section aria-labelledby="who-gets-what-heading" className="space-y-3">
      {heading}
      <p className="text-sm" data-testid="who-gets-what-summary">
        {extras ? `${manifest.line}.` : `${people}, one email each.`}
      </p>
      {copies > 0 ? (
        <p className="text-sm text-[var(--fg-muted)]">
          With {copies} CC and BCC {copies === 1 ? 'copy' : 'copies'}, this counts as{' '}
          <span className="font-medium text-[var(--fg)]">{summary.effectiveTotal} emails</span>{' '}
          toward the {DAILY_CAP}-a-day limit
          {summary.effectiveTotal > DAILY_CAP
            ? `; at most ${DAILY_CAP} go out in 24 hours, and the rest wait for the next slot.`
            : '.'}
        </p>
      ) : null}
      {copying && manifest.tracking ? (
        <p className="text-xs text-[var(--fg-muted)]">
          A copy is the same email, so opens and clicks by anyone copied
          {manifest.unsubscribe ? ' (and its unsubscribe link)' : ''} count as the
          recipient&rsquo;s.
        </p>
      ) : null}
      {manifest.warnings.length ? (
        <Notice>
          <ul className="space-y-0.5">
            {manifest.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {manifest.version !== version ? (
        <p className="text-xs text-[var(--warn)]">
          The campaign changed after this review was read. Go back and review it again before
          sending.
        </p>
      ) : null}
      {manifest.rows.length > PAGE ? (
        <Input
          type="search"
          aria-label="Search who gets what"
          placeholder="Search by name, address, photo or flag"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          className="max-w-80"
        />
      ) : null}
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
        <table
          className={`w-full text-left text-xs ${extras ? 'min-w-[40rem]' : ''}`}
          aria-label="Who gets what"
        >
          <thead className="text-[var(--fg-muted)]">
            <tr className="border-b border-[var(--border)]">
              <th scope="col" className="px-3 py-2 font-medium">
                To
              </th>
              {extras ? (
                <th scope="col" className="px-3 py-2 font-medium">
                  Photo
                </th>
              ) : null}
              <th scope="col" className="px-3 py-2 font-medium">
                Shared attachments
              </th>
              {extras ? (
                <>
                  <th scope="col" className="px-3 py-2 font-medium">
                    CC
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    BCC
                  </th>
                </>
              ) : null}
              <th scope="col" className="px-3 py-2 font-medium">
                Flags
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {shown.map((r) => (
              <tr key={r.id} className="align-top">
                <th scope="row" className="px-3 py-2 font-normal">
                  <span className="block font-medium break-all">{r.name ?? r.to}</span>
                  {r.name ? (
                    <span className="block break-all text-[var(--fg-muted)]">{r.to}</span>
                  ) : null}
                </th>
                {extras ? (
                  <td className="px-3 py-2 break-all">
                    {r.photo ? (
                      r.photo.name
                    ) : r.flags.some((f) => f.text === 'Photo missing') ? (
                      <span className="text-[var(--warn)]">missing</span>
                    ) : (
                      <span className="text-[var(--fg-subtle)]">none</span>
                    )}
                  </td>
                ) : null}
                <td className="px-3 py-2 break-all">
                  {r.attachments.length ? (
                    r.attachments.join(', ')
                  ) : (
                    <span className="text-[var(--fg-subtle)]">none</span>
                  )}
                </td>
                {extras ? <CopyCells row={r} /> : null}
                <td className="px-3 py-2">
                  {r.flags.length ? (
                    <span className="flex flex-col items-start gap-1">
                      {r.flags.map((f) => (
                        <Badge
                          key={f.text}
                          tone={f.level === 'block' ? 'danger' : 'warn'}
                          className="whitespace-normal"
                        >
                          {f.text}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    <span className="text-[var(--fg-subtle)]">—</span>
                  )}
                </td>
              </tr>
            ))}
            {!shown.length ? (
              <tr>
                <td colSpan={extras ? 6 : 3} className="px-3 py-3 text-[var(--fg-muted)]">
                  {q ? 'Nobody matches that search.' : 'Nobody is waiting to be sent to.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {rows.length > PAGE ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--fg-muted)]">
          <span aria-live="polite">
            {current * PAGE + 1}–{Math.min(rows.length, (current + 1) * PAGE)} of {rows.length}
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Previous page"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Next page"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
      <p className="text-xs text-[var(--fg-subtle)]">
        In send order.
        {summary.problems ? ' A row with a problem stops the send until it is fixed.' : ''}
      </p>
    </section>
  );
}

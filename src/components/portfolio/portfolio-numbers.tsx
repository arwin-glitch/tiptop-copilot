import type { ReactNode } from 'react';
import Link from 'next/link';
import { after } from 'next/server';
import { ExternalLink } from 'lucide-react';
import type { CompanyLike } from '@/lib/company-updates/classify';
import {
  formatMoney,
  sparkline,
  type CompanyNumbers,
  type MetricPoint,
  type Sourced,
} from '@/lib/company-updates/metrics';
import { gmailThreadUrl } from '@/lib/deals/links';
import { getStore } from '@/lib/runtime';
import { loadPortfolioNumbers } from '@/lib/services/portfolio-numbers';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import { formatDate, formatDateTime } from '@/lib/util/time';
import { SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Portfolio: the numbers each company reported in its own update emails.
 * Every figure is the company's word, shown with the date of the email it
 * came from and a link to that email. Companies with no numbers are left out.
 * Shown from the last stored read; a stale one is refreshed in the background.
 */
export async function PortfolioNumbers({
  organizationId,
  companies,
  timeZone,
}: {
  organizationId: string;
  companies: readonly CompanyLike[];
  timeZone: string;
}) {
  if (companies.length === 0) return null;
  const loaded = await loadPortfolioNumbers(getStore(), organizationId, companies).catch(
    () => null,
  );
  // The refresh finishes after the response; `after` keeps it alive.
  const pending = loaded?.pending;
  if (pending) {
    after(async () => {
      await pending;
    });
  }
  const result = loaded?.result ?? null;

  const heading = (count?: number) => (
    <SectionHeading count={count}>
      <span id="portfolio-numbers-heading">Numbers from their updates</span>
    </SectionHeading>
  );

  if (!result || result.state !== 'ok') {
    return (
      <section aria-labelledby="portfolio-numbers-heading" className="mb-8">
        {heading()}
        <p className="text-sm text-[var(--fg-muted)]">
          {result?.state === 'pending'
            ? 'Reading the numbers from Gmail for the first time. Refresh in a minute to see them.'
            : result?.state === 'not_connected'
              ? 'Connect Gmail in Settings to read the numbers founders share in their updates.'
              : "Gmail didn't answer, so the numbers are hidden for now. Try again in a minute."}
        </p>
      </section>
    );
  }

  const rows = result.companies;
  return (
    <section aria-labelledby="portfolio-numbers-heading" className="mb-8">
      {heading(rows.length)}
      <p className="-mt-2 mb-1 text-sm text-[var(--fg-muted)]">
        Company-reported figures from founder update emails in the last 12 months, read from Gmail.
        Nothing here is checked against other sources. Each figure shows the date of the email it
        came from.
      </p>
      <p className="mb-3 text-xs text-[var(--fg-subtle)]" data-numbers-updated>
        Updated{' '}
        <time dateTime={result.checkedAt}>{formatDateTime(result.checkedAt, timeZone)}</time>
        {loaded?.refreshing ? ' · checking Gmail for newer updates' : ''} · Checked {result.checked}{' '}
        {result.checked === 1 ? 'company' : 'companies'} · {rows.length} shared numbers
        {result.partial ? ' · some mail not read yet, refresh in a minute for the rest' : ''}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--fg-subtle)]">
          No numbers found in their update emails yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((c) => (
            <NumbersRow key={c.companyId} numbers={c} timeZone={timeZone} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NumbersRow({ numbers: c, timeZone }: { numbers: CompanyNumbers; timeZone: string }) {
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return (
    <li>
      <Card>
        <CardContent className="pt-3.5 pb-3.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-serif text-base font-semibold break-words">
              {c.name}
              <Link
                href={`/portfolio/${c.companyId}`}
                aria-label={`${c.name} company page`}
                className="ml-2 font-sans text-xs font-normal text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Company page
              </Link>
            </h3>
            <Badge tone="outline">Company-reported</Badge>
          </div>
          <dl className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {c.revenue ? (
              <MetricCell
                label={c.revenue.value.kind}
                value={c.revenue.value.display}
                sourced={c.revenue}
                timeZone={timeZone}
                extra={
                  <TrendLine history={c.history} kind={c.revenue.value.kind} timeZone={timeZone} />
                }
              />
            ) : null}
            {c.growth ? (
              <MetricCell
                label="Growth"
                value={c.growth.value.label}
                sourced={c.growth}
                timeZone={timeZone}
              />
            ) : null}
            {c.cash ? (
              <MetricCell
                label="Cash"
                value={c.cash.value.display}
                sourced={c.cash}
                timeZone={timeZone}
              />
            ) : null}
            {c.runway ? (
              <MetricCell
                label="Runway"
                value={capital(c.runway.value.label)}
                sourced={c.runway}
                timeZone={timeZone}
              />
            ) : null}
            {c.raising ? (
              <MetricCell
                label="Raising"
                value={capital(c.raising.value.label)}
                sourced={c.raising}
                timeZone={timeZone}
                wide
              />
            ) : null}
          </dl>
        </CardContent>
      </Card>
    </li>
  );
}

function MetricCell({
  label,
  value,
  sourced,
  timeZone,
  extra,
  wide,
}: {
  label: string;
  value: string;
  sourced: Sourced<{ evidence: string }>;
  timeZone: string;
  extra?: ReactNode;
  wide?: boolean;
}) {
  const href = gmailThreadUrl(sourced.threadId, DEFAULT_MAILBOX);
  return (
    <div className={wide ? 'min-w-0 sm:col-span-2 lg:col-span-1' : 'min-w-0'}>
      <dt className="text-mini font-medium tracking-wide text-[var(--fg-subtle)] uppercase">
        {label}
      </dt>
      <dd className="mt-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="tabular font-medium break-words" title={sourced.value.evidence}>
            {value}
          </span>
          {extra}
        </span>
        <span className="block text-xs text-[var(--fg-subtle)]">
          as of {formatDate(sourced.asOf, timeZone)}
          {href ? (
            <>
              {' · '}
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Source email <ExternalLink className="size-3" aria-hidden />
              </a>
            </>
          ) : null}
        </span>
      </dd>
    </div>
  );
}

const WIDTH = 76;
const HEIGHT = 24;
const PAD = 3;

/**
 * The reported figure over time, drawn to scale: x by date, y from zero (the
 * faint line is zero). Hovering a point shows its value and date.
 */
function TrendLine({
  history,
  kind,
  timeZone,
}: {
  history: MetricPoint[];
  kind: string;
  timeZone: string;
}) {
  const line = sparkline(history, { width: WIDTH, height: HEIGHT, pad: PAD });
  if (!line) return null;
  const describe = (p: MetricPoint) =>
    `${formatMoney(p.amount)} ${kind}, ${formatDate(p.date, timeZone)}`;
  const label = `${kind} trend from zero: ${history.map(describe).join('; ')}`;
  const last = line.points.at(-1);
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label={label}
      className="shrink-0 overflow-visible"
    >
      <line
        x1={PAD}
        x2={WIDTH - PAD}
        y1={HEIGHT - PAD}
        y2={HEIGHT - PAD}
        stroke="var(--border)"
        strokeWidth={1}
      />
      <path
        d={line.path}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {last ? <circle cx={last.x} cy={last.y} r={2.5} fill="var(--accent)" /> : null}
      {line.points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={6} fill="transparent">
          <title>{describe(history[i]!)}</title>
        </circle>
      ))}
    </svg>
  );
}

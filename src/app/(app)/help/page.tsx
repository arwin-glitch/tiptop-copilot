import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, CircleHelp, Play, Sparkles } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import {
  HELP_PAGES,
  HELP_SECTIONS,
  helpPage,
  helpSection,
  tourHref,
  tourSteps,
  type HelpPage,
} from '@/lib/help/registry';
import { GRAND_TOUR_ID, TOUR_PARAM } from '@/lib/help/tour-ids';
import { WHATS_NEW, type WhatsNewItem } from '@/lib/help/whats-new';
import { HELP_ICONS } from '@/components/help/help-icons';
import { PageSketch, SketchPin } from '@/components/help/page-sketch';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, FieldLabel } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Help' };
// Behind sign-in like every page in the app, so rendered per request.
export const dynamic = 'force-dynamic';

/**
 * Help: what every page holds and where to click, as pictures first. One card
 * per page: what it is for, a sketch of the page with numbered pins, the same
 * numbers as a one-line legend, its tabs, and two buttons: "Show me" runs the
 * page's guided tour on the real page, "Open" just goes there. "What's new"
 * opens the page with the latest changes, one line each, and the 2-minute
 * tour under it walks one stop on every page. New areas inside a page (a tab
 * with its own tour) get cards of their own after the pages.
 *
 * Everything comes from lib/help/registry.ts and lib/help/whats-new.ts, so the
 * cards, the tours and the Records tab labels cannot drift apart.
 */

/** "Thursday, Oct 22" for a YYYY-MM-DD day, the same wherever it is read. */
function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** What's new, by day, newest day first, each day's lines in their order. */
function whatsNewByDay(): { date: string; items: WhatsNewItem[] }[] {
  const days: { date: string; items: WhatsNewItem[] }[] = [];
  for (const item of WHATS_NEW) {
    const day = days.find((d) => d.date === item.date);
    if (day) day.items.push(item);
    else days.push({ date: item.date, items: [item] });
  }
  return days.sort((a, b) => b.date.localeCompare(a.date));
}

export default async function HelpPage() {
  await requireAuth();
  const grandStops = tourSteps(GRAND_TOUR_ID).length;
  // The route of the 2-minute tour, by page, in the order it walks them.
  const route = HELP_PAGES.filter((p) => p.steps.some((s) => s.grand));

  return (
    <PageShell>
      <PageHeader
        eyebrow="Help & tours"
        title="How Kraken works"
        subtitle="What every page holds and where to click. Tap Show me and the page walks you through itself."
      />

      <p className="mb-4 text-sm text-[var(--fg-muted)]">
        Tip: you can also ask Arwin where anything is.
      </p>

      <WhatsNew />

      <section
        aria-labelledby="grand-tour-heading"
        className="shadow-raised mb-10 flex flex-col gap-4 rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--bg-raised)] bg-[image:var(--surface-sheen)] p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between"
      >
        <div className="min-w-0">
          <p className="text-micro font-medium tracking-[0.16em] text-[var(--label-gold)] uppercase">
            {grandStops} stops · about 2 minutes
          </p>
          <h2 id="grand-tour-heading" className="text-title mt-0.5 font-serif font-semibold">
            New here? See it all in one go
          </h2>
          <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
            One stop on every page, in menu order. Esc ends it anytime.
          </p>
          {/* The route, which doubles as an index: each stop jumps to its card. */}
          <ol
            aria-label="Pages on the tour"
            className="mt-3 flex flex-wrap items-center gap-1.5 lg:gap-0"
          >
            {route.map((page, i) => {
              const Icon = HELP_ICONS[page.id] ?? CircleHelp;
              return (
                <li key={page.id} className="flex items-center">
                  {i > 0 ? (
                    <span
                      aria-hidden="true"
                      className="hidden h-px w-3 bg-[var(--gold-rule)] lg:block"
                    />
                  ) : null}
                  <a
                    href={`#help-${page.id}`}
                    aria-label={`Jump to ${page.name}`}
                    title={page.name}
                    className="flex size-8 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--accent-soft)] text-[var(--accent)] transition-colors duration-[var(--motion-instant)] hover:border-[var(--accent)]"
                  >
                    <Icon className="size-3.5" aria-hidden="true" />
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
        <Button asChild variant="primary" size="lg" className="shrink-0">
          <Link href={`/today?${TOUR_PARAM}=${GRAND_TOUR_ID}`}>
            <Play aria-hidden="true" />
            Take the 2-minute tour
          </Link>
        </Button>
      </section>

      {/* One grid in menu order, Ask Arwin last: four across on a wide
          screen, so the whole app fits in a few rows rather than a long scroll. */}
      <section aria-labelledby="help-pages-heading">
        <FieldLabel
          as="h2"
          id="help-pages-heading"
          className="mb-3 tracking-[0.18em] text-[var(--label-gold)]"
        >
          Every page
        </FieldLabel>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {HELP_PAGES.map((page) => (
            <li key={page.id} id={`help-${page.id}`} className="scroll-mt-24">
              <HelpCard page={page} />
            </li>
          ))}
        </ul>
      </section>

      {/* New areas inside a page: a tab with a short tour of its own. */}
      <section aria-labelledby="help-tabs-heading" className="mt-10">
        <FieldLabel
          as="h2"
          id="help-tabs-heading"
          className="tracking-[0.18em] text-[var(--label-gold)]"
        >
          Tabs with their own tour
        </FieldLabel>
        <p className="mt-0.5 mb-3 text-sm text-[var(--fg-muted)]">
          New areas inside a page. Show me opens the tab and walks it.
        </p>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {HELP_SECTIONS.map((tab) => (
            <li key={tab.id} id={`help-${tab.id}`} className="scroll-mt-24">
              <HelpCard page={tab} />
            </li>
          ))}
        </ul>
      </section>
    </PageShell>
  );
}

/**
 * The latest changes, one line each, by day: an icon for the page, the line
 * (which opens the page or tab), a "Coming soon" tag on what is off for now,
 * and Show me where a tour covers it.
 */
function WhatsNew() {
  const days = whatsNewByDay();
  if (days.length === 0) return null;
  return (
    <section aria-labelledby="whats-new-heading" className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="size-4 text-[var(--label-gold)]" aria-hidden="true" />
        <FieldLabel
          as="h2"
          id="whats-new-heading"
          className="tracking-[0.18em] text-[var(--label-gold)]"
        >
          What&rsquo;s new
        </FieldLabel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {days.map(({ date, items }) => (
          <Card key={date} className="min-w-0" aria-labelledby={`whats-new-${date}`}>
            <div className="flex items-baseline justify-between gap-3 px-4 pt-4">
              <h3 id={`whats-new-${date}`} className="text-title font-serif font-semibold">
                {dayLabel(date)}
              </h3>
              <span className="text-micro font-medium tracking-[0.12em] text-[var(--fg-subtle)] uppercase">
                {items.length} {items.length === 1 ? 'change' : 'changes'}
              </span>
            </div>
            <ol aria-label={`New on ${dayLabel(date)}`} className="mt-2 px-2 pb-2">
              {items.map((item) => (
                <WhatsNewRow key={item.text} item={item} />
              ))}
            </ol>
          </Card>
        ))}
      </div>
    </section>
  );
}

function WhatsNewRow({ item }: { item: WhatsNewItem }) {
  const page = helpPage(item.page);
  const Icon = HELP_ICONS[item.page] ?? CircleHelp;
  const href = item.href ?? page?.href ?? '/help';
  const tourName = item.tour ? (helpSection(item.tour) ?? helpPage(item.tour))?.name : undefined;
  return (
    <li className="flex items-center gap-3 border-t border-[var(--border)] px-2 py-2 first:border-t-0">
      <span
        aria-hidden="true"
        title={page?.name}
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]"
      >
        <Icon className="size-3.5" />
      </span>
      <Link
        href={href}
        prefetch={false}
        className="min-w-0 flex-1 text-sm text-[var(--fg)] transition-colors duration-[var(--motion-instant)] hover:text-[var(--accent)]"
      >
        {item.text}
        {item.soon ? (
          <Badge tone="outline" className="ml-1.5 align-middle">
            Coming soon
          </Badge>
        ) : null}
      </Link>
      {item.tour && tourName ? (
        <Link
          href={tourHref(helpSection(item.tour) ?? helpPage(item.tour)!)}
          prefetch={false}
          aria-label={`Take the ${tourName} tour`}
          title="Show me"
          className="text-mini flex shrink-0 items-center gap-1 rounded-full border border-[var(--border-strong)] px-2 py-1 text-[var(--accent)] transition-colors duration-[var(--motion-instant)] hover:border-[var(--accent)]"
        >
          <Play className="size-3" aria-hidden="true" />
          <span className="hidden sm:inline">Show me</span>
        </Link>
      ) : null}
    </li>
  );
}

function HelpCard({ page }: { page: HelpPage }) {
  const Icon = HELP_ICONS[page.id] ?? CircleHelp;
  const headingId = `help-card-${page.id}`;
  // A step that comes back to an earlier target keeps that target's number.
  const legend = page.steps
    .map((step, i) => ({ step, n: i + 1 }))
    .filter(({ step }, i) => page.steps.findIndex((s) => s.target === step.target) === i);

  return (
    <Card className="flex h-full flex-col" aria-labelledby={headingId} role="group">
      <div className="flex items-center gap-2.5 px-4 pt-4">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]"
        >
          <Icon className="size-4" />
        </span>
        <h3 id={headingId} className="text-title font-serif font-semibold">
          {page.name}
        </h3>
      </div>
      <p className="mt-1.5 px-4 text-sm text-[var(--fg-muted)]">{page.purpose}</p>

      <div className="mt-3 px-4">
        <PageSketch page={page} />
      </div>

      <ol aria-label="Where to click" className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1.5 px-4">
        {legend.map(({ step, n }) => (
          <li
            key={step.target}
            className="text-mini flex items-center gap-1.5 text-[var(--fg-muted)]"
          >
            <SketchPin n={n} />
            {step.title}
          </li>
        ))}
      </ol>

      {page.subtabs.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 px-4">
          <span className="text-micro font-medium tracking-[0.12em] text-[var(--fg-subtle)] uppercase">
            Tabs
          </span>
          {page.subtabs.map((tab) =>
            tab.href ? (
              <Link
                key={tab.key}
                href={tab.href}
                prefetch={false}
                title={tab.blurb}
                className="text-mini rounded-full border border-[var(--border-strong)] px-2 py-0.5 text-[var(--fg)] transition-colors duration-[var(--motion-instant)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                {tab.label}
              </Link>
            ) : (
              <span
                key={tab.key}
                title={tab.blurb}
                className="text-mini rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--fg-muted)]"
              >
                {tab.label}
              </span>
            ),
          )}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2 px-4 pt-4 pb-4">
        <Button asChild variant="primary" size="sm">
          <Link href={tourHref(page)} prefetch={false} aria-label={`Show me ${page.name}`}>
            <Play aria-hidden="true" />
            Show me
          </Link>
        </Button>
        <Button asChild variant="secondary" size="sm">
          <Link href={page.href ?? '/ask'} prefetch={false} aria-label={`Open ${page.name}`}>
            Open
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </Card>
  );
}

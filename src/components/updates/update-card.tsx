import type { ReactNode } from 'react';
import { CalendarDays, ChevronDown, ChevronRight, ExternalLink, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Blocks, Mrkdwn } from '@/components/updates/mrkdwn';
import { IconChip, postStyle } from '@/components/updates/style';
import { cn } from '@/lib/util/cn';
import { formatDate, relativeTime } from '@/lib/util/time';
import { safeHref } from '@/lib/updates/mrkdwn';
import type {
  Block,
  DealflowPost,
  DigestItem,
  DigestPost,
  OtherPost,
  ReportSection,
  RosterPost,
  UpdatePost,
  UpdateSource,
} from '@/lib/updates/types';

/**
 * One Slack post as a card. Every long body opens on a short preview or
 * stays inside a closed <details>, so a 50,000-character digest thread
 * reads as a list of titles until something is opened — never a text dump.
 */

interface CardProps {
  post: UpdatePost;
  source: UpdateSource;
  now: Date;
  timeZone: string;
  /** Everything below the header row starts collapsed. */
  compact?: boolean;
  footer?: ReactNode;
}

const SUMMARY_RESET = 'cursor-pointer list-none [&::-webkit-details-marker]:hidden';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function posted(post: UpdatePost, now: Date, timeZone: string): string {
  return `Posted ${relativeTime(post.postedAt, now)} · ${formatDate(post.postedAt, timeZone)}`;
}

function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return null;
  return (
    <Button asChild variant="secondary" size="sm" className="shrink-0">
      <a href={safe} target="_blank" rel="noreferrer">
        <ExternalLink aria-hidden="true" />
        {children}
      </a>
    </Button>
  );
}

function CardShell({
  post,
  source,
  compact,
  footer,
  eyebrow,
  title,
  meta,
  clampTitle = false,
  children,
}: Omit<CardProps, 'now' | 'timeZone'> & {
  eyebrow?: string | null;
  title: string;
  meta: string;
  clampTitle?: boolean;
  children: ReactNode;
}) {
  const style = postStyle(post, source);
  const header = (
    // Full width on phones, so "Open in Slack" wraps below instead of squeezing the title.
    <div className="flex min-w-0 flex-1 items-start gap-3 max-sm:basis-full">
      <IconChip icon={style.icon} className={style.chip} />
      <div className="min-w-0 flex-1">
        {eyebrow ? (
          <p className="text-mini mb-0.5 line-clamp-1 text-[var(--fg-subtle)]">{eyebrow}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CardTitle
            as="h3"
            className={cn('min-w-0 [overflow-wrap:break-word]', clampTitle && 'line-clamp-1')}
          >
            {title}
          </CardTitle>
          <Badge tone={style.badgeTone} className="whitespace-normal">
            {style.badgeLabel}
          </Badge>
        </div>
        <p className="text-mini mt-1 line-clamp-2 text-[var(--fg-subtle)] sm:line-clamp-1">
          {meta}
        </p>
      </div>
    </div>
  );
  const open = post.permalink ? (
    <ExternalButton href={post.permalink}>Open in Slack</ExternalButton>
  ) : null;
  const rail = <div className={cn('h-1', style.rail)} aria-hidden="true" />;

  if (compact) {
    return (
      <Card className="overflow-hidden">
        {rail}
        <details className="group/card">
          <summary className={cn(SUMMARY_RESET, 'flex items-start gap-3 px-4 py-3 sm:px-5')}>
            {header}
            <ChevronDown
              className="mt-2 size-4 shrink-0 text-[var(--fg-subtle)] transition-transform group-open/card:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <CardContent className="space-y-3">
            {open ? <div>{open}</div> : null}
            {children}
          </CardContent>
        </details>
        {footer ? <CardFooter>{footer}</CardFooter> : null}
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      {rail}
      <CardHeader className="flex-wrap">
        {header}
        {open}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
      {footer ? <CardFooter>{footer}</CardFooter> : null}
    </Card>
  );
}

function Chips({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

/** A collapsed section: "<Title> · <count>" until opened. */
function Section({
  title,
  count,
  children,
  muted = false,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <details className="group/sec border-t border-[var(--border)] first:border-t-0">
      <summary
        className={cn(
          SUMMARY_RESET,
          'flex items-center justify-between gap-2 py-2.5 text-sm font-medium',
          muted && 'text-[var(--fg-muted)]',
        )}
      >
        <span>
          {title}
          {count !== undefined ? ` · ${count}` : ''}
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-[var(--fg-subtle)] transition-transform group-open/sec:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="pb-3">{children}</div>
    </details>
  );
}

function SectionList({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-[var(--border)] px-3">{children}</div>;
}

/** Replies from people, muted, one after another. */
function NoteList({ notes }: { notes: { blocks: Block[]; correction?: boolean }[] }) {
  return (
    <ul className="space-y-2.5">
      {notes.map((note, i) => (
        <li key={i} className="flex flex-wrap items-start gap-2 text-[var(--fg-muted)]">
          {note.correction ? <Badge tone="outline">Correction</Badge> : null}
          <Blocks blocks={note.blocks} className="min-w-0 flex-1" />
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------------- dealflow */

type DealHead = Extract<Block, { type: 'numbered' | 'bullet' }>;

/** Numbered items (or top-level bullets) with whatever follows each one. */
function groupDeals(blocks: Block[]): {
  lead: Block[];
  deals: { head: DealHead; body: Block[] }[];
} {
  const numbered = blocks.some((b) => b.type === 'numbered');
  const lead: Block[] = [];
  const deals: { head: DealHead; body: Block[] }[] = [];
  for (const b of blocks) {
    const isHead = numbered ? b.type === 'numbered' : b.type === 'bullet' && b.depth === 0;
    if (isHead && (b.type === 'numbered' || b.type === 'bullet')) deals.push({ head: b, body: [] });
    else if (deals.length > 0) deals[deals.length - 1]?.body.push(b);
    else lead.push(b);
  }
  return { lead, deals };
}

function DealList({ blocks }: { blocks: Block[] }) {
  const { lead, deals } = groupDeals(blocks);
  return (
    <div className="space-y-1">
      {lead.length > 0 ? <Blocks blocks={lead} /> : null}
      {deals.map((deal, i) => {
        const marker = deal.head.type === 'numbered' ? `${deal.head.n}.` : '•';
        if (deal.body.length === 0) {
          return (
            <div key={i} className="flex gap-2 py-1 text-sm [overflow-wrap:anywhere]">
              <span className="tabular shrink-0 text-[var(--fg-subtle)]">{marker}</span>
              <span className="min-w-0">
                <Mrkdwn segs={deal.head.segs} />
              </span>
            </div>
          );
        }
        return (
          <details key={i} className="group/deal">
            <summary className={cn(SUMMARY_RESET, 'flex items-start gap-2 py-1 text-sm')}>
              <ChevronRight
                className="mt-1 size-3.5 shrink-0 text-[var(--fg-subtle)] transition-transform group-open/deal:rotate-90"
                aria-hidden="true"
              />
              <span className="tabular shrink-0 text-[var(--fg-subtle)]">{marker}</span>
              <span className="line-clamp-1 min-w-0 font-semibold [overflow-wrap:anywhere]">
                <Mrkdwn segs={deal.head.segs} />
              </span>
            </summary>
            <Blocks blocks={deal.body} className="pb-2 pl-6" />
          </details>
        );
      })}
    </div>
  );
}

function sectionCount(section: ReportSection): number | undefined {
  if (section.key === 'new' || section.key === 'updates') return section.count ?? undefined;
  return section.count ? section.count : undefined;
}

/** Deadline lines for the preview: its items, else its paragraph lines. */
function deadlineLines(section: ReportSection | undefined): Block[] {
  if (!section) return [];
  const items = section.blocks.filter(
    (b) => b.type === 'numbered' || (b.type === 'bullet' && b.depth === 0),
  );
  if (items.length > 0) return items;
  return section.blocks.flatMap((b): Block[] =>
    b.type === 'para' ? b.lines.map((segs) => ({ type: 'bullet', depth: 0, segs })) : [],
  );
}

function DealflowCard({
  post,
  source,
  now,
  timeZone,
  compact,
  footer,
}: CardProps & { post: DealflowPost }) {
  const summary = post.sections.find((s) => s.key === 'summary');
  const bullets = summary?.blocks.filter((b) => b.type === 'bullet' && b.depth === 0) ?? [];
  const firstPara = summary?.blocks.find((b) => b.type === 'para');
  const deadlines = deadlineLines(post.sections.find((s) => s.key === 'deadlines')).slice(0, 3);
  const { newDeals, updates } = post.counts;
  const meta = [posted(post, now, timeZone), ...post.meta];
  if (compact && newDeals !== null) meta.splice(1, 0, plural(newDeals, 'new deal'));

  return (
    <CardShell
      post={post}
      source={source}
      compact={compact}
      footer={footer}
      eyebrow={post.heading}
      title={`${source.label} · ${post.windowLabel ?? formatDate(post.postedAt, timeZone)}`}
      meta={meta.join(' · ')}
    >
      <Chips>
        {newDeals !== null ? <Badge tone="info">{plural(newDeals, 'new deal')}</Badge> : null}
        {updates ? <Badge tone="neutral">{plural(updates, 'update')}</Badge> : null}
        {/* Only when both sections say "None" — prose the parser cannot count is not quiet. */}
        {newDeals === 0 && updates === 0 ? <Badge tone="neutral">Quiet week</Badge> : null}
        {post.flags.baseline ? <Badge tone="outline">Baseline</Badge> : null}
        {post.flags.incremental ? <Badge tone="outline">Incremental</Badge> : null}
        {post.flags.confidential ? (
          <Badge tone="warn">
            <Lock className="size-3" aria-hidden="true" />
            Confidential
          </Badge>
        ) : null}
        {post.settling ? <Badge tone="neutral">Still posting</Badge> : null}
        {post.threadMissing ? <Badge tone="warn">Thread not loaded</Badge> : null}
      </Chips>

      {bullets.length > 0 ? (
        <Blocks blocks={bullets.slice(0, 3)} clamp={2} />
      ) : firstPara ? (
        <Blocks blocks={[firstPara]} clamp={3} />
      ) : null}

      {deadlines.length > 0 ? (
        <ul className="space-y-1" aria-label="Next deadlines">
          {deadlines.map((b, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-[var(--fg-muted)]">
              <CalendarDays
                className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]"
                aria-hidden="true"
              />
              <span className="line-clamp-1 min-w-0 [overflow-wrap:anywhere]">
                <Mrkdwn segs={b.type === 'para' ? b.lines.flat() : b.segs} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {post.sections.length > 0 || post.notes.length > 0 ? (
        <SectionList>
          {post.sections.map((section, i) => (
            <Section
              key={`${section.key}-${i}`}
              title={section.title}
              count={sectionCount(section)}
            >
              {section.key === 'new' ? (
                <DealList blocks={section.blocks} />
              ) : (
                <Blocks blocks={section.blocks} />
              )}
            </Section>
          ))}
          {post.notes.length > 0 ? (
            <Section title="Replies" count={post.notes.length} muted>
              <NoteList notes={post.notes.map((blocks) => ({ blocks }))} />
            </Section>
          ) : null}
        </SectionList>
      ) : null}
    </CardShell>
  );
}

/* ----------------------------------------------------------------- digest */

function ItemRow({ item }: { item: DigestItem }) {
  return (
    <details className="group/item border-t border-[var(--border)] first:border-t-0">
      <summary className={cn(SUMMARY_RESET, 'flex items-start gap-2 py-2 text-sm')}>
        <ChevronRight
          className="mt-1 size-3.5 shrink-0 text-[var(--fg-subtle)] transition-transform group-open/item:rotate-90"
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
          <span className="font-semibold">{item.title}</span>
          {item.detail ? <span className="text-[var(--fg-muted)]">{item.detail}</span> : null}
          {item.cadence ? (
            <Badge tone="outline" className="whitespace-normal">
              {item.cadence}
            </Badge>
          ) : null}
          {item.newsletter ? <Badge tone="neutral">Newsletter</Badge> : null}
          {item.locked ? (
            <Badge tone="warn">
              <Lock className="size-3" aria-hidden="true" />
              Investors only
            </Badge>
          ) : null}
          {item.needsAttention ? (
            <>
              <span className="size-2 rounded-full bg-[var(--warn)]" aria-hidden="true" />
              <span className="sr-only">Needs attention</span>
            </>
          ) : null}
        </span>
      </summary>
      <div className="space-y-2.5 pb-3 pl-5.5">
        {item.lockNote ? (
          <p className="text-mini flex items-start gap-1.5 text-[var(--fg-muted)]">
            <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            {item.lockNote}
          </p>
        ) : null}
        {item.repost ? (
          <p className="text-mini text-[var(--fg-muted)]">Reposted: {item.repost}</p>
        ) : null}
        {item.meta.length > 0 ? (
          <div>
            {item.meta.map((m, i) => (
              <p key={i} className="text-mini line-clamp-1 text-[var(--fg-subtle)]">
                {m}
              </p>
            ))}
          </div>
        ) : null}
        {item.groups.map((g, i) => (
          <div
            key={i}
            className={cn(
              g.tone === 'attention' &&
                'rounded-md border border-[var(--warn)]/40 bg-[var(--warn-soft)] px-3 py-2',
              g.tone === 'done' && 'text-[var(--fg-muted)]',
            )}
          >
            {g.label ? (
              <p className="text-micro mb-1 font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                {g.label}
              </p>
            ) : null}
            <Blocks blocks={g.blocks} />
          </div>
        ))}
        {item.links.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {item.links.map((l, i) => (
              <ExternalButton key={i} href={l.href}>
                {l.label}
              </ExternalButton>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** The routine is waiting on a decision: kept in view, its detail one click away. */
function AskBox({ blocks }: { blocks: Block[] }) {
  const lead = blocks[0]?.type === 'label' ? 2 : 1;
  const rest = blocks.slice(lead);
  return (
    <div className="rounded-md border border-[var(--warn)]/40 bg-[var(--warn-soft)] px-3 py-2">
      <p className="text-micro mb-1 font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
        Needs your call
      </p>
      <Blocks blocks={blocks.slice(0, lead)} clamp={3} />
      {rest.length > 0 ? (
        <details className="group/ask">
          <summary
            className={cn(SUMMARY_RESET, 'flex items-center gap-1 pt-1.5 text-sm font-medium')}
          >
            <ChevronRight
              className="size-3.5 shrink-0 text-[var(--fg-subtle)] transition-transform group-open/ask:rotate-90"
              aria-hidden="true"
            />
            Details
          </summary>
          <Blocks blocks={rest} className="pt-1.5" />
        </details>
      ) : null}
    </div>
  );
}

function DigestCard({
  post,
  source,
  now,
  timeZone,
  compact,
  footer,
}: CardProps & { post: DigestPost }) {
  const date = post.dateLabel || formatDate(post.postedAt, timeZone);
  const title = post.kind === 'repost' ? `Repost · ${date}` : `${post.kindLabel} digest · ${date}`;
  const attentionCount = post.items.filter((i) => i.needsAttention).length;
  const meta = [`Posted ${relativeTime(post.postedAt, now)}`];
  if (post.covering) meta.push(post.covering);
  if (compact && post.counts) meta.splice(1, 0, plural(post.counts.total, 'update'));

  return (
    <CardShell
      post={post}
      source={source}
      compact={compact}
      footer={footer}
      eyebrow={source.label}
      title={title}
      meta={meta.join(' · ')}
    >
      <Chips>
        {post.counts ? (
          <Badge tone="neutral">
            {plural(post.counts.total, 'update')} · {post.counts.weekly} weekly /{' '}
            {post.counts.monthly} monthly
          </Badge>
        ) : null}
        {post.provisional ? <Badge tone="warn">Provisional</Badge> : null}
        {post.empty ? <Badge tone="neutral">Nothing new</Badge> : null}
        {attentionCount > 0 ? <Badge tone="warn">Needs attention · {attentionCount}</Badge> : null}
        {post.settling ? <Badge tone="neutral">Still posting</Badge> : null}
        {post.threadMissing ? <Badge tone="warn">Thread not loaded</Badge> : null}
      </Chips>

      {post.attention.length > 0 ? (
        <Blocks blocks={post.attention.slice(0, 4)} clamp={2} />
      ) : post.callouts.length > 0 ? (
        <Blocks blocks={post.callouts.slice(0, 3)} clamp={2} />
      ) : post.items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {post.items.slice(0, 5).map((item, i) => (
            <Badge key={i} tone="outline" className="whitespace-normal">
              {item.title}
            </Badge>
          ))}
        </div>
      ) : null}

      {post.asks.length > 0 ? <AskBox blocks={post.asks} /> : null}

      {post.items.length > 0 ||
      post.lead.length > 0 ||
      post.meta.length > 0 ||
      post.housekeeping.length > 0 ||
      post.notes.length > 0 ? (
        <SectionList>
          {post.items.length > 0 ? (
            <Section title="Updates" count={post.items.length}>
              <div>
                {post.items.map((item, i) => (
                  <ItemRow key={i} item={item} />
                ))}
              </div>
            </Section>
          ) : null}
          {post.lead.length > 0 || post.meta.length > 0 ? (
            <Section title="Run notes" muted>
              <div className="space-y-2">
                {post.meta.map((m, i) => (
                  <p key={i} className="text-mini text-[var(--fg-subtle)]">
                    {m}
                  </p>
                ))}
                <Blocks blocks={post.lead} className="text-[var(--fg-muted)]" />
              </div>
            </Section>
          ) : null}
          {post.housekeeping.length > 0 ? (
            <Section title="Housekeeping" muted>
              <Blocks blocks={post.housekeeping} className="text-[var(--fg-muted)]" />
            </Section>
          ) : null}
          {post.notes.length > 0 ? (
            <Section title="Notes" count={post.notes.length} muted>
              <NoteList notes={post.notes} />
            </Section>
          ) : null}
        </SectionList>
      ) : null}
    </CardShell>
  );
}

/* ----------------------------------------------------------------- roster */

function listCount(list: RosterPost['lists'][number]): number {
  return (
    list.count ?? list.blocks.filter((b) => b.type === 'numbered' || b.type === 'bullet').length
  );
}

function RosterCard({
  post,
  source,
  now,
  timeZone,
  compact,
  footer,
}: CardProps & { post: RosterPost }) {
  return (
    <CardShell
      post={post}
      source={source}
      compact={compact}
      footer={footer}
      eyebrow={source.label}
      title={`Roster v${post.version}`}
      meta={`${posted(post, now, timeZone)} · the series each digest run covers`}
    >
      <Chips>
        {post.lists.length > 0 ? (
          <Badge tone="neutral" className="whitespace-normal">
            {post.lists.map((l) => `${listCount(l)} ${l.title.toLowerCase()}`).join(' · ')}
          </Badge>
        ) : null}
        {post.confidential ? (
          <Badge tone="warn">
            <Lock className="size-3" aria-hidden="true" />
            Investors only
          </Badge>
        ) : null}
      </Chips>
      <SectionList>
        {post.lists.map((list, i) => (
          <Section key={i} title={list.title} count={listCount(list)}>
            <Blocks blocks={list.blocks} />
          </Section>
        ))}
        {post.appendix.length > 0 ? (
          <Section title="Appendix" muted>
            <Blocks blocks={post.appendix} className="text-[var(--fg-muted)]" />
          </Section>
        ) : null}
      </SectionList>
    </CardShell>
  );
}

/* ------------------------------------------------------------------ other */

function OtherCard({
  post,
  source,
  now,
  timeZone,
  compact,
  footer,
}: CardProps & { post: OtherPost }) {
  return (
    <CardShell
      post={post}
      source={source}
      compact={compact}
      footer={footer}
      eyebrow={source.label}
      title={post.firstLine}
      meta={posted(post, now, timeZone)}
      clampTitle
    >
      {post.fileOnly ? (
        <p className="text-sm text-[var(--fg-muted)]">This post is a file — open it in Slack.</p>
      ) : (
        <>
          <Blocks blocks={post.blocks.slice(0, 3)} clamp={2} />
          <SectionList>
            <Section title="Full post">
              <Blocks blocks={post.blocks} />
            </Section>
          </SectionList>
        </>
      )}
    </CardShell>
  );
}

export function UpdatePostCard(props: CardProps) {
  const { post } = props;
  switch (post.type) {
    case 'dealflow':
      return <DealflowCard {...props} post={post} />;
    case 'digest':
      return <DigestCard {...props} post={post} />;
    case 'roster':
      return <RosterCard {...props} post={post} />;
    default:
      return <OtherCard {...props} post={post} />;
  }
}

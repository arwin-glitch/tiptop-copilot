'use client';

import * as React from 'react';
import { BookOpen, Moon, Sun } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/cn';
import { relativeTime } from '@/lib/util/time';
import type { RoutineBriefing } from '@/lib/types/domain';

/**
 * The routine posts full content now (every section, not a teaser), which
 * makes for a wall of text on first paint — exactly what a card at the top
 * of the page should not be. Collapsed to a short preview by default; the
 * full text is already in the DOM, just clamped, so it stays searchable and
 * accessible without a second request.
 */
function BriefingSummary({ summary }: { summary: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const isLong = summary.length > 320 || summary.split('\n').length > 6;

  return (
    <div>
      <p
        className="text-[15px] leading-relaxed whitespace-pre-line"
        style={
          expanded || !isLong
            ? undefined
            : {
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        {summary}
      </p>
      {isLong ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 -ml-2"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </div>
  );
}

const KIND_STYLE: Record<
  RoutineBriefing['kind'],
  {
    icon: React.ComponentType<{ className?: string }>;
    badgeTone: BadgeProps['tone'];
    label: string;
  }
> = {
  morning: { icon: Sun, badgeTone: 'info', label: 'Morning' },
  afternoon: { icon: Moon, badgeTone: 'neutral', label: 'Afternoon' },
  dossier: { icon: BookOpen, badgeTone: 'outline', label: 'Dossier' },
};

/**
 * One routine-posted card — the current brief (morning or afternoon,
 * whichever is current for today) or the standing meeting dossier. Visually
 * identical shape for both, differing only in the icon/tone that names which
 * one this is, so the two read as a matched pair rather than one primary
 * card and an afterthought.
 */
export function RoutineBriefingCard({
  briefing,
  now,
  className,
}: {
  briefing: RoutineBriefing;
  now: Date;
  className?: string;
}) {
  const { icon: Icon, badgeTone, label } = KIND_STYLE[briefing.kind];
  const postedLabel = relativeTime(briefing.posted_at, now);

  return (
    <Card className={cn('overflow-hidden', className)}>
      <div
        className={cn(
          'h-1',
          briefing.kind === 'dossier' ? 'bg-[var(--fg-subtle)]/40' : 'bg-[var(--accent)]',
        )}
        aria-hidden="true"
      />
      <CardHeader>
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-full',
              briefing.kind === 'dossier'
                ? 'bg-[var(--neutral-soft)] text-[var(--fg-muted)]'
                : 'bg-[var(--accent-soft)] text-[var(--accent)]',
            )}
            aria-hidden="true"
          >
            <Icon className="size-4.5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle as="h2">{briefing.title}</CardTitle>
              <Badge tone={badgeTone}>{label}</Badge>
            </div>
            <p className="mt-1.5 text-xs text-[var(--fg-subtle)]">
              Posted {postedLabel} by the triage fleet
            </p>
          </div>
        </div>
        {briefing.source_url ? (
          <Button asChild variant="secondary" size="sm" className="shrink-0">
            <a href={briefing.source_url} target="_blank" rel="noreferrer">
              Open full {briefing.kind === 'dossier' ? 'dossier' : 'briefing'}
            </a>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <BriefingSummary summary={briefing.summary} />
      </CardContent>
    </Card>
  );
}

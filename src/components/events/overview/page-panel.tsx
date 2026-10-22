import Link from 'next/link';
import { ExternalLink, Lock, Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import { CopyLinkButton } from '@/components/events/library/card-actions';
import { eventPaths, type EventPanelProps } from '@/lib/events/contracts';
import { blockRegistry } from '@/lib/events/blocks';
import { parseEventDoc, type EventSection } from '@/lib/events/schema';
import { getStore } from '@/lib/runtime';
import { outsideEditsSincePublish } from '@/lib/services/event-overview';
import { formatDateTime } from '@/lib/util/time';

const VISIBILITY_TEXT: Record<EventSection['visibility']['mode'], string | null> = {
  everyone: null,
  registered: 'Registered guests only',
  going: 'Going guests only',
  tags: 'Tagged guests only',
  hidden: 'Hidden',
};

/**
 * The Page tab: what is live, what is waiting in the draft, and the way into
 * Studio, where the page itself is edited and published. Lists the draft's
 * sections in order so the page can be checked at a glance without opening
 * the editor. Reads only.
 */
export async function PagePanel({ event, viewer }: EventPanelProps) {
  const parsed = parseEventDoc(event.draft_doc);
  const sections = parsed.ok
    ? [...parsed.value.sections].sort((a, b) =>
        a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
      )
    : [];
  const outside = await outsideEditsSincePublish(getStore(), viewer.organizationId, event);
  const live = event.status === 'published';
  const changes = event.published_at
    ? Math.max(0, event.draft_version - event.published_draft_version)
    : null;

  return (
    <div data-panel="page" className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <Card aria-labelledby="page-state-title">
        <CardHeader>
          <CardTitle as="h2" id="page-state-title">
            Live page and draft
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--fg-muted)]">Live</dt>
              <dd className="text-right">
                {live && event.published_at
                  ? `Since ${formatDateTime(event.published_at, viewer.timeZone)}`
                  : event.status === 'cancelled'
                    ? 'Shows the cancelled notice'
                    : 'Not published'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--fg-muted)]">Draft</dt>
              <dd className="text-right">
                {changes === null
                  ? 'Everything is in the draft'
                  : changes === 0
                    ? 'Same as the live page'
                    : `${changes} ${changes === 1 ? 'change' : 'changes'} not published`}
              </dd>
            </div>
            {outside ? (
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--fg-muted)]">Outside edits</dt>
                <dd className="text-right">{outside} waiting for you to publish</dd>
              </div>
            ) : null}
          </dl>
          {event.editing_paused ? (
            <Notice tone="warn">Outside editing is paused for this event.</Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="primary" size="sm">
              <Link href={eventPaths.studio(event.id)}>
                <Pencil aria-hidden="true" />
                Open Studio
              </Link>
            </Button>
            {live ? (
              <Button asChild variant="secondary" size="sm">
                {/* A full page load, never next/link: the guest page has its own CSP and no Copilot chrome. */}
                <a href={eventPaths.page(event.slug)} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden="true" />
                  View live page
                </a>
              </Button>
            ) : null}
            <CopyLinkButton slug={event.slug} live={live} variant="secondary" />
          </div>
          <p className="text-xs text-[var(--fg-muted)]">
            Edits in Studio save to the draft. The live page changes only when you publish.
          </p>
        </CardContent>
      </Card>

      <Card aria-labelledby="page-outline-title">
        <CardHeader>
          <div>
            <CardTitle as="h2" id="page-outline-title">
              Sections in the draft
            </CardTitle>
            <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
              Top to bottom, as guests will see them.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {!parsed.ok ? (
            <Notice tone="warn">
              The draft could not be read. Open Studio and restore an earlier version from History.
            </Notice>
          ) : sections.length === 0 ? (
            <p className="text-sm text-[var(--fg-muted)]">No sections yet. Add them in Studio.</p>
          ) : (
            <ol className="divide-y divide-[var(--border)]">
              {sections.map((section, i) => {
                const definition = blockRegistry.get(section.type);
                const label = section.name || definition?.label || section.type;
                const summary = definition?.summary(section.props);
                const gate = VISIBILITY_TEXT[section.visibility.mode];
                return (
                  <li key={section.id} className="flex items-start gap-3 py-2">
                    <span className="tabular mt-0.5 w-5 shrink-0 text-right text-xs text-[var(--fg-subtle)]">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{label}</p>
                      {summary && summary !== label ? (
                        <p className="truncate text-sm text-[var(--fg-muted)]">{summary}</p>
                      ) : null}
                    </div>
                    {gate ? (
                      <Badge tone="outline" className="shrink-0">
                        <Lock className="size-3" aria-hidden="true" />
                        {gate}
                      </Badge>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

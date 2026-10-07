import { ExternalLink, HeartHandshake, Snowflake } from 'lucide-react';
import { gmailThreadUrl } from '@/lib/deals/links';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import type { RelationshipItem, Relationships } from '@/lib/services/follow-ups';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { relativeTime } from '@/lib/util/time';

const KIND_LABEL: Record<RelationshipItem['kind'], string> = {
  lp: 'LP',
  prospective_lp: 'Prospective LP',
  portfolio: 'Portfolio',
  founder: 'Founder',
  coinvestor: 'Co-investor',
  other: 'Contact',
};

/**
 * The relationship radar's snapshot: who is waiting on Nick, and which key
 * relationships have gone quiet. Plain text only; the only link is rebuilt
 * from a validated Gmail thread id.
 */
export { AlertList };

export function RelationshipAlerts({
  relationships,
  now,
  showWaiting = true,
}: {
  relationships: Relationships;
  now: Date;
  /** Network shows only "Going cold"; who is waiting on Nick lives on Follow-ups. */
  showWaiting?: boolean;
}) {
  const waiting = showWaiting ? relationships.waiting : [];
  if (waiting.length === 0 && relationships.cold.length === 0) return null;
  return (
    <Card className="mb-6">
      <CardHeader>
        <div>
          <CardTitle>Relationship alerts</CardTitle>
          <p className="text-xs text-[var(--fg-subtle)]">
            Checked {relativeTime(relationships.run_at, now)}
          </p>
        </div>
      </CardHeader>
      <CardContent className={showWaiting ? 'grid gap-5 sm:grid-cols-2' : undefined}>
        {showWaiting ? (
          <AlertList
            title="Waiting on Nick"
            icon={<HeartHandshake className="size-4 text-[var(--warn)]" aria-hidden />}
            items={waiting}
            empty="Nobody important is waiting."
            unit="waiting"
          />
        ) : null}
        <AlertList
          title="Going cold"
          icon={<Snowflake className="size-4 text-[var(--info)]" aria-hidden />}
          items={relationships.cold}
          empty="No key relationship has gone quiet."
          unit="since last contact"
        />
      </CardContent>
    </Card>
  );
}

function AlertList({
  title,
  icon,
  items,
  empty,
  unit,
}: {
  title: string;
  icon: React.ReactNode;
  items: RelationshipItem[];
  empty: string;
  unit: string;
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        {icon}
        {title}
        <span className="tabular text-xs font-normal text-[var(--fg-subtle)]">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--fg-subtle)]">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const href = item.thread_id ? gmailThreadUrl(item.thread_id, DEFAULT_MAILBOX) : null;
            return (
              <li key={`${item.who}-${item.since}`} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">
                      {item.who}
                      {item.company ? (
                        <span className="font-normal text-[var(--fg-muted)]">
                          {' '}
                          · {item.company}
                        </span>
                      ) : null}
                    </span>
                    <Badge tone="neutral">{KIND_LABEL[item.kind]}</Badge>
                  </div>
                  <p className="text-xs text-[var(--fg-subtle)]">
                    {item.days} {item.days === 1 ? 'day' : 'days'} {unit}
                    {item.note ? ` · ${item.note}` : ''}
                  </p>
                </div>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open the thread with ${item.who} in Gmail`}
                    className="mt-0.5 text-[var(--accent)]"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

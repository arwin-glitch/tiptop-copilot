import { BadgeCheck, KeyRound, ShieldAlert } from 'lucide-react';
import { noticeSentence, type EditorNotice } from '@/lib/services/event-editors';

/**
 * Notices about outside links, newest first. A server component, so it can
 * sit on the Sharing tab and (through WS5) on Today. Plain text only.
 */
export function EditorNotices({
  notices,
  timeZone,
  empty = 'Nothing yet. You will see first opens and review requests here.',
}: {
  notices: readonly EditorNotice[];
  timeZone: string;
  empty?: string;
}) {
  if (!notices.length) return <p className="text-sm text-[var(--fg-muted)]">{empty}</p>;
  return (
    <ul aria-label="Link activity" className="space-y-2">
      {notices.map((n) => (
        <li key={n.id} className="flex items-start gap-2 text-sm">
          {n.kind === 'ready_for_review' ? (
            <BadgeCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--ok)]" />
          ) : n.kind === 'new_device' ? (
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--warn)]" />
          ) : (
            <KeyRound
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--fg-muted)]"
            />
          )}
          <span className="min-w-0">
            {noticeSentence(n)}
            {n.note ? <span className="block text-[var(--fg-muted)]">“{n.note}”</span> : null}
            <span className="block text-xs text-[var(--fg-muted)]">
              {new Date(n.at).toLocaleString('en-US', {
                timeZone,
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

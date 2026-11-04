import type { ContactStatus } from '@/lib/network/contact-status';
import { ContactStatusTag, formatContactDate } from './contact-status-tag';

/**
 * Under a profile's name: the status tag and the last contact in words
 * ("Oct 25, 2026 at 1:27 PM: Nick Tippmann sent an email to ada@x.example").
 * Takes the computation as a promise so the header paints first.
 */
export async function ProfileContactLine({
  summary,
  timezone,
}: {
  summary: Promise<{ ok: true; value: ContactLineData | null } | { ok: false }>;
  timezone: string;
}) {
  const result = await summary;
  if (!result.ok || !result.value) return null;
  const s = result.value;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-profile-contact="">
      <ContactStatusTag status={s.status} />
      <span className="text-mini text-[var(--fg-muted)]">
        {s.lastContactAt ? (
          <>
            Last contact {formatContactDate(s.lastContactAt, timezone, true)}
            {s.lastTouchText ? `: ${s.lastTouchText}` : ''}
          </>
        ) : s.matchable ? (
          'No email or meeting on record'
        ) : (
          'Nothing to match against mail and calendar'
        )}
      </span>
    </span>
  );
}

export interface ContactLineData {
  status: ContactStatus;
  lastContactAt: string | null;
  lastTouchText: string | null;
  matchable: boolean;
}

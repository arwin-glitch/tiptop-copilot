import type { Metadata } from 'next';
import { StaffEntry } from '@/components/events/checkin/staff-entry';
import { EventShell } from '@/components/events/ticket/event-shell';

/**
 * /e/checkin — the staff link's entry (D-075). The secret is in #k=, which
 * the browser never sends; the client strips it and claims it by POST on an
 * explicit tap. Never indexed (proxy.ts: X-Robots-Tag, no Referer).
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { absolute: 'Door check-in' },
  applicationName: null,
  appleWebApp: null,
  robots: { index: false, follow: false, nocache: true },
};

export default function StaffEntryPage() {
  return (
    <EventShell doc={null} label="Door check-in">
      <StaffEntry />
    </EventShell>
  );
}

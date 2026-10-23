import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { isDemoMode } from '@/lib/config/env';
import { notesAccess } from '@/lib/notes/flag';
import { getStore } from '@/lib/runtime';
import { getMeetingDetail, listFolders, listRecipes, listTemplates } from '@/lib/services/notes';
import { meetingHasPendingRequest, settleNotesFromRelay } from '@/lib/services/notes-bridge';
import { MEETINGS_TABS } from '@/lib/records-tabs';
import { tabHref } from '@/lib/util/page-tabs';
import { formatDateTime } from '@/lib/util/time';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { ErrorState } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import { MeetingWorkspace } from '@/components/notes/meeting-workspace';
import { WORKSPACE_TABS, lengthWords, type WorkspaceTab } from '@/components/notes/helpers';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTES_HREF = tabHref(MEETINGS_TABS.path, 'notes', MEETINGS_TABS.defaultKey);

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  if (!UUID.test(id)) return { title: 'Meeting' };
  const auth = await requireAuth();
  const store = getStore();
  const access = await notesAccess(store, auth);
  if (!access.enabled) return { title: 'Meeting' };
  const detail = await getMeetingDetail({ store, auth }, id);
  return { title: detail.ok ? detail.value.meeting.title : 'Meeting' };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A Copilot meeting (D-076): its notes, live transcript, chat, people and
 * share links, behind subtabs. Hidden (404) while Copilot Notes is off for
 * this person, and for a meeting they may not see.
 */
export default async function MeetingPage({
  params,
  searchParams,
}: Params & { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!UUID.test(id)) notFound();
  const auth = await requireAuth();
  const store = getStore();
  const access = await notesAccess(store, auth);
  if (!access.enabled) notFound();
  const ctx = { store, auth };
  // Arwin's notes may have come back while nobody had this page open.
  if (await meetingHasPendingRequest(store, auth.organizationId, id)) {
    await settleNotesFromRelay(store, auth.organizationId, { ctx });
  }
  const detail = await getMeetingDetail(ctx, id);

  const back = (
    <Link
      href={NOTES_HREF}
      className="text-mini mb-3 inline-flex items-center gap-1 text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
      <ArrowLeft className="size-3.5" aria-hidden /> All notes
    </Link>
  );

  if (!detail.ok) {
    if (detail.error.code === 'not_found') notFound();
    return (
      <PageShell>
        {back}
        <PageHeader title="Meeting" />
        {detail.error.code === 'not_configured' ? (
          <NotConfigured
            title="Copilot Notes is not set up yet"
            description={detail.error.message}
            stillWorks={detail.error.stillUsable}
          />
        ) : (
          <ErrorState
            title="This meeting could not be loaded"
            message={detail.error.message}
            stillUsable="Granola notes on the Notes tab."
          />
        )}
      </PageShell>
    );
  }

  const [templates, recipes, folders] = await Promise.all([
    listTemplates(ctx),
    listRecipes(ctx),
    listFolders(ctx),
  ]);
  const meeting = detail.value.meeting;
  const tz = auth.profile.timezone;
  const askedTab = single(query.tab);
  const tab: WorkspaceTab = WORKSPACE_TABS.includes(askedTab as WorkspaceTab)
    ? (askedTab as WorkspaceTab)
    : 'notes';
  const at = Number.parseInt(single(query.t) ?? '', 10);
  const speed = Number.parseFloat(single(query.mockSpeed) ?? '');
  const demo = isDemoMode();
  // The browser recorder everywhere; demo mode plays the scripted call (no
  // microphone needed) unless ?capture=live asks for the recorder against the demo engine.
  const engine = demo && single(query.capture) !== 'live' ? 'scripted' : 'live';
  const when = meeting.startedAt ?? meeting.scheduledStart ?? meeting.createdAt;
  // The live state (recording, notes ready) is in the bar below, which keeps up.
  const subtitle = [formatDateTime(when, tz), lengthWords(meeting.recordedMs)]
    .filter(Boolean)
    .join(' · ');

  return (
    <PageShell>
      {back}
      <PageHeader eyebrow="Meeting notes" title={meeting.title} subtitle={subtitle} />
      <MeetingWorkspace
        initial={detail.value}
        templates={templates.ok ? templates.value : []}
        recipes={recipes.ok ? recipes.value : []}
        folders={folders.ok ? folders.value : []}
        timeZone={tz}
        demo={demo}
        mockSpeed={Number.isFinite(speed) && speed > 0 && speed <= 200 ? speed : 6}
        engine={engine}
        initialTab={tab}
        initialAtMs={Number.isFinite(at) && at >= 0 ? at : null}
        openConsent={single(query.start) === '1'}
      />
    </PageShell>
  );
}

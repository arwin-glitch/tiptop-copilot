import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { notesAccess } from '@/lib/notes/flag';
import { getStore } from '@/lib/runtime';
import { listFolders, listRecipes, listTemplates } from '@/lib/services/notes';
import { getPreferences, listRecordingRules } from '@/lib/services/notes-settings';
import { listVoiceProfiles } from '@/lib/services/voice-profiles';
import { MEETINGS_TABS } from '@/lib/records-tabs';
import { VOICE_CONSENT_TEXT } from '@/lib/types/notes';
import { resolveTab, tabHref } from '@/lib/util/page-tabs';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/feedback';
import { SpeechSettings } from '@/components/capture/speech-settings';
import { PageTabs } from '@/components/ui/page-tabs';
import {
  FoldersRecipesSettings,
  NotesBetaSwitch,
  NotesPreferencesSettings,
  RulesSettings,
  TemplatesSettings,
  VoicesSettings,
} from '@/components/notes/notes-settings';

export const metadata: Metadata = { title: 'Notes settings' };
export const dynamic = 'force-dynamic';

const PATH = '/meetings/settings';
const TABS = [
  { key: 'templates', label: 'Templates' },
  { key: 'speech', label: 'Speech' },
  { key: 'rules', label: 'Never record' },
  { key: 'voices', label: 'Voices' },
  { key: 'folders', label: 'Folders & recipes' },
] as const;
type SettingsTab = (typeof TABS)[number]['key'];

/**
 * Copilot Notes settings (D-076), one section per subtab: templates, speech
 * (the on-device Whisper model), never-record rules, voice consent, folders
 * and recipes. The beta switch
 * sits above them (and on the main Settings page).
 */
export default async function NotesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const auth = await requireAuth();
  const store = getStore();
  const access = await notesAccess(store, auth);
  if (access.mode === 'off') notFound();
  const ctx = { store, auth };
  const tab = resolveTab<SettingsTab>(
    query.tab,
    TABS.map((t) => t.key),
    'templates',
  );

  const back = (
    <Link
      href={tabHref(MEETINGS_TABS.path, 'notes', MEETINGS_TABS.defaultKey)}
      className="text-mini mb-3 inline-flex items-center gap-1 text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
      <ArrowLeft className="size-3.5" aria-hidden /> All notes
    </Link>
  );

  return (
    <PageShell>
      {back}
      <PageHeader
        eyebrow="Copilot Notes"
        title="Notes settings"
        subtitle="Templates for the notes, speech on this computer, meetings that are never recorded, voice consent, and folders."
      />
      <Card className="mb-6">
        <CardContent className="pt-4">
          <NotesBetaSwitch initial={access} />
        </CardContent>
      </Card>
      {!access.enabled ? (
        <p className="text-sm text-[var(--fg-muted)]">Turn Copilot Notes on above to set it up.</p>
      ) : (
        <>
          <Card className="mb-6">
            <CardContent className="pt-4">
              <NotesPreferencesSettings initial={await getPreferences(ctx)} />
            </CardContent>
          </Card>
          <PageTabs
            label="Notes settings sections"
            path={PATH}
            tabs={TABS.map((t) => ({ key: t.key, label: t.label }))}
            active={tab}
            defaultKey="templates"
          />
          <Card>
            <CardContent className="pt-4">
              <Section tab={tab} ctx={ctx} />
            </CardContent>
          </Card>
        </>
      )}
    </PageShell>
  );
}

async function Section({
  tab,
  ctx,
}: {
  tab: SettingsTab;
  ctx: { store: ReturnType<typeof getStore>; auth: Awaited<ReturnType<typeof requireAuth>> };
}) {
  const failed = (message: string) => (
    <ErrorState
      title="This could not be loaded"
      message={message}
      stillUsable="The other sections."
    />
  );
  if (tab === 'templates') {
    const templates = await listTemplates(ctx);
    return templates.ok ? (
      <TemplatesSettings initial={templates.value} />
    ) : (
      failed(templates.error.message)
    );
  }
  // Speech settings live in this browser (the model is cached here): nothing to read.
  if (tab === 'speech') return <SpeechSettings />;
  if (tab === 'rules') {
    const rules = await listRecordingRules(ctx);
    // A count only: the server's own list never reaches the browser.
    return rules.ok ? (
      <RulesSettings
        initial={rules.value}
        serverListCount={env().notesNeverRecord.length}
        demo={env().demoMode}
      />
    ) : (
      failed(rules.error.message)
    );
  }
  if (tab === 'voices') {
    const profiles = await listVoiceProfiles(ctx);
    return profiles.ok ? (
      <VoicesSettings
        initial={profiles.value}
        consentText={VOICE_CONSENT_TEXT}
        ownEmail={ctx.auth.profile.email ?? ''}
        ownName={ctx.auth.profile.full_name ?? null}
        timeZone={ctx.auth.profile.timezone}
      />
    ) : (
      failed(profiles.error.message)
    );
  }
  const [folders, recipes] = await Promise.all([listFolders(ctx), listRecipes(ctx)]);
  if (!folders.ok) return failed(folders.error.message);
  if (!recipes.ok) return failed(recipes.error.message);
  return <FoldersRecipesSettings folders={folders.value} recipes={recipes.value} />;
}

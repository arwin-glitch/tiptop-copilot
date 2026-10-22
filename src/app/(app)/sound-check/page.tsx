import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireAuth } from '@/lib/auth/session';
import { demoEngine, demoTuning } from '@/lib/capture/demo-tuning';
import { isDemoMode } from '@/lib/config/env';
import { notesAccess } from '@/lib/notes/flag';
import { getStore } from '@/lib/runtime';
import { DemoRecording } from '@/components/capture/demo-recording';
import { SoundCheckPanel } from '@/components/capture/sound-check-panel';
import { PageHeader, PageShell } from '@/components/shell/page-header';

export const metadata: Metadata = { title: 'Sound check' };
export const dynamic = 'force-dynamic';

/**
 * Copilot Notes' sound check (D-076, WS3): test the microphone and the
 * meeting audio before a call, on this computer only. Hidden unless Copilot
 * Notes is on for this person. In demo mode it can also record the made-up
 * demo call end to end, which is what the recorder's end-to-end tests drive,
 * or (?engine=fake, ?engine=on-device) the on-device Whisper engine.
 */
export default async function SoundCheckPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requireAuth();
  const access = await notesAccess(getStore(), auth);
  if (!access.enabled) notFound();
  const demo = isDemoMode();
  const params = await searchParams;
  const tuning = demo ? demoTuning(params) : undefined;
  const engine = demo ? demoEngine(params) : undefined;

  return (
    <PageShell>
      <PageHeader
        eyebrow="Copilot Notes"
        title="Sound check"
        subtitle="Make sure Copilot hears you and the meeting before you record a call."
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <SoundCheckPanel />
        {demo ? <DemoRecording tuning={tuning} engine={engine} /> : null}
      </div>
    </PageShell>
  );
}

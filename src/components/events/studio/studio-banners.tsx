'use client';

import * as React from 'react';
import { Ban, Eye, Pause, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRestoreVersion } from './history-drawer';
import { useStudio } from './studio-context';

/** The strip under the top bar: who you are here and what that means. */
export function StudioBanners() {
  const { boot, sessionState, versionPreview, setVersionPreview } = useStudio();
  const restore = useRestoreVersion();
  const [restoring, setRestoring] = React.useState(false);
  const lines: { icon: React.ReactNode; text: string; tone: 'info' | 'warn' }[] = [];
  if (boot.actor.outside && boot.actor.role === 'editor') {
    lines.push({
      icon: <UserRound aria-hidden="true" className="size-4" />,
      text: 'Outside editor · changes go live only when TipTop publishes',
      tone: 'info',
    });
  }
  if (boot.actor.role === 'viewer') {
    lines.push({
      icon: <Eye aria-hidden="true" className="size-4" />,
      text: 'Preview only · this is the unpublished draft',
      tone: 'info',
    });
  }
  if (sessionState.editingPaused && boot.actor.outside) {
    lines.push({
      icon: <Pause aria-hidden="true" className="size-4" />,
      text: 'Editing is paused by TipTop. You can look around; your changes wait until it reopens.',
      tone: 'warn',
    });
  }
  if (sessionState.editingPaused && boot.actor.owner) {
    lines.push({
      icon: <Pause aria-hidden="true" className="size-4" />,
      text: 'Editing is paused for outside editors (Sharing tab).',
      tone: 'info',
    });
  }
  if (!lines.length && !versionPreview) return null;
  return (
    <div className="shrink-0">
      {versionPreview ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--warn-soft)] px-4 py-1.5 text-sm"
        >
          <Eye aria-hidden="true" className="size-4" />
          <span className="min-w-0 flex-1">Previewing {versionPreview.label} (read-only)</span>
          {boot.capabilities.restoreVersions ? (
            <Button
              size="sm"
              variant="primary"
              loading={restoring}
              onClick={async () => {
                setRestoring(true);
                await restore(versionPreview.versionId);
                setRestoring(false);
              }}
            >
              Restore as draft
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => setVersionPreview(null)}>
            Back to editing
          </Button>
        </div>
      ) : null}
      {lines.map((line) => (
        <p
          key={line.text}
          role="status"
          className={
            line.tone === 'warn'
              ? 'flex items-center gap-2 border-b border-[var(--border)] bg-[var(--warn-soft)] px-4 py-1.5 text-sm text-[var(--fg)]'
              : 'flex items-center gap-2 border-b border-[var(--border)] bg-[var(--accent-soft)] px-4 py-1.5 text-sm text-[var(--fg)]'
          }
        >
          {line.icon}
          <span className="min-w-0">{line.text}</span>
        </p>
      ))}
    </div>
  );
}

/** The dead end when a link stops working mid-session (revoked, regenerated, expired). */
export function LostScreen({ outside }: { outside: boolean }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--bg)] p-6 text-[var(--fg)]">
      <div className="max-w-md space-y-3 text-center">
        <Ban aria-hidden="true" className="mx-auto size-8 text-[var(--fg-muted)]" />
        <h1 className="font-serif text-2xl font-semibold">
          {outside ? 'This link is no longer active' : 'This event is no longer available'}
        </h1>
        <p className="text-sm text-[var(--fg-muted)]">
          {outside
            ? 'TipTop has ended this editing session. Ask them for a new link if you still need to make changes.'
            : 'It may have been deleted or archived. Go back to Events to find it.'}
        </p>
      </div>
    </div>
  );
}

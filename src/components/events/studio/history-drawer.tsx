'use client';

import * as React from 'react';
import { toast } from 'sonner';
import type { DraftSnapshot } from '@/lib/events/contracts';
import { studioFetch } from '@/lib/events/editor/api';
import { fieldName } from '@/lib/events/editor/publish';
import { parseEventDoc, type EventDoc } from '@/lib/events/schema';
import { cn } from '@/lib/util/cn';
import { Button } from '@/components/ui/button';
import { Dialog, Drawer } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form';
import { useStudio } from './studio-context';

/** What WS1's GET …/versions lists (lib/services/event-versions.ts EventVersionSummary). */
interface VersionSummary {
  id: string;
  version: number;
  kind: 'autosave' | 'named' | 'published' | 'pre_restore' | 'restore';
  name: string | null;
  draftVersion: number;
  authorName: string | null;
  createdAt: string;
  summary: string[];
}

interface ActivityRow {
  draftVersion: number;
  op: string;
  sectionId: string | null;
  keys: string[];
  authorName: string;
  outside: boolean;
  at: string;
}

const KIND_LABEL: Record<VersionSummary['kind'], string> = {
  autosave: 'Autosave',
  named: 'Named',
  published: 'Published',
  pre_restore: 'Before a restore',
  restore: 'Restored',
};

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * History (owners): the version timeline (autosaves, named, published,
 * pre-restore) with a read-only preview of any version in the canvas, and
 * "Restore as draft", which never overwrites anything and still needs a
 * Publish. Plus the page's activity log with names stored at the time.
 * Versions come from WS1's /api/events/[id]/versions routes.
 */
export function HistoryDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const studio = useStudio();
  const { boot } = studio;
  const [tab, setTab] = React.useState<'versions' | 'activity'>('versions');
  const [versions, setVersions] = React.useState<VersionSummary[] | null>(null);
  const [versionsError, setVersionsError] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<ActivityRow[] | null>(null);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    if (!boot.endpoints.versions) return;
    let live = true;
    void studioFetch<{ versions: VersionSummary[] }>(boot.endpoints.versions).then((r) => {
      if (!live) return;
      if (r.ok) {
        setVersions(r.value.versions ?? []);
        setVersionsError(null);
      } else {
        setVersionsError(
          r.status === 404 || r.status === 503
            ? 'Version history is still being built. Editing and saving work as before.'
            : r.error.message,
        );
      }
    });
    return () => {
      live = false;
    };
  }, [boot.endpoints.versions, reload]);

  React.useEffect(() => {
    if (!boot.endpoints.activity || tab !== 'activity') return;
    let live = true;
    void studioFetch<{ entries: ActivityRow[] }>(boot.endpoints.activity).then((r) => {
      if (live) setActivity(r.ok ? r.value.entries : []);
    });
    return () => {
      live = false;
    };
  }, [boot.endpoints.activity, tab]);

  async function preview(v: VersionSummary) {
    if (!boot.endpoints.versions) return;
    setBusy(v.id);
    const r = await studioFetch<{ doc: unknown }>(`${boot.endpoints.versions}/${v.id}`);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.status === 404 ? 'Previewing versions is still being built.' : r.error.message);
      return;
    }
    const parsed = parseEventDoc(r.value.doc);
    if (!parsed.ok) {
      toast.error('That version could not be read.');
      return;
    }
    studio.setVersionPreview({
      versionId: v.id,
      label: v.name ? `“${v.name}”` : `version ${v.version}`,
      doc: parsed.value,
    });
    onOpenChange(false);
  }

  async function nameVersion() {
    if (!boot.endpoints.versions || !name.trim()) return;
    setBusy('name');
    await studio.session.flush();
    const r = await studioFetch(boot.endpoints.versions, {
      method: 'POST',
      json: { name: name.trim() },
    });
    setBusy(null);
    if (r.ok) {
      setName('');
      setReload((n) => n + 1);
      toast.success('Version saved.');
    } else {
      toast.error(r.status === 404 ? 'Naming versions is still being built.' : r.error.message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Drawer title="History" description="Versions of this page and who changed what.">
        <div role="tablist" aria-label="History" className="mb-3 flex gap-1">
          {(['versions', 'activity'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-3 py-1 text-sm',
                tab === t
                  ? 'bg-[var(--primary)] text-[var(--primary-fg)]'
                  : 'hover:bg-[var(--bg-hover)]',
              )}
            >
              {t === 'versions' ? 'Versions' : 'Activity'}
            </button>
          ))}
        </div>
        {tab === 'versions' ? (
          <div className="space-y-3">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void nameVersion();
              }}
            >
              <label className="sr-only" htmlFor="version-name">
                Name this version
              </label>
              <Input
                id="version-name"
                placeholder="Name this version, e.g. Before the partner's pass"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
              <Button type="submit" loading={busy === 'name'} disabled={!name.trim()}>
                Save
              </Button>
            </form>
            {versionsError ? (
              <p className="text-sm text-[var(--fg-muted)]">{versionsError}</p>
            ) : null}
            {versions && !versions.length ? (
              <p className="text-sm text-[var(--fg-muted)]">No versions yet.</p>
            ) : null}
            <ol aria-label="Versions" className="space-y-2">
              {(versions ?? []).map((v) => (
                <li key={v.id} className="rounded-md border border-[var(--border)] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {v.name ?? `Version ${v.version}`}{' '}
                        <span className="text-xs font-normal text-[var(--fg-muted)]">
                          · {KIND_LABEL[v.kind]}
                        </span>
                      </p>
                      <p className="text-xs text-[var(--fg-muted)]">
                        {v.authorName ?? 'Someone'} · {when(v.createdAt)}
                      </p>
                      {v.summary.length ? (
                        <p className="mt-1 text-xs">{v.summary.slice(0, 3).join(' · ')}</p>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === v.id}
                      onClick={() => void preview(v)}
                    >
                      Preview
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <ActivityList rows={activity} />
        )}
      </Drawer>
    </Dialog>
  );
}

function ActivityList({ rows }: { rows: ActivityRow[] | null }) {
  const studio = useStudio();
  if (!rows) return <p className="text-sm text-[var(--fg-muted)]">Loading…</p>;
  if (!rows.length)
    return <p className="text-sm text-[var(--fg-muted)]">No changes recorded yet.</p>;
  return (
    <ol aria-label="Activity" className="space-y-2">
      {rows.map((row, i) => {
        const section = row.sectionId
          ? studio.doc.sections.find((s) => s.id === row.sectionId)
          : null;
        const where =
          row.op === 'theme'
            ? 'the theme'
            : row.op === 'page'
              ? 'page settings'
              : section
                ? studio.labelOf(section)
                : 'a section';
        const what =
          row.op === 'insert'
            ? `added ${where}`
            : row.op === 'delete'
              ? 'deleted a section'
              : row.op === 'move'
                ? `moved ${where}`
                : `changed ${row.keys.map(fieldName).join(', ')} in ${where}`;
        return (
          <li key={i} className="text-sm">
            <span className="font-medium">
              {row.authorName}
              {row.outside ? ' (outside)' : ''}
            </span>{' '}
            {what}
            <span className="block text-xs text-[var(--fg-muted)]">{when(row.at)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** "Restore as draft" from the version preview banner (owners). */
export function useRestoreVersion() {
  const studio = useStudio();
  return React.useCallback(
    async (versionId: string) => {
      const { boot, editor, session } = studio;
      if (!boot.endpoints.versions || !boot.capabilities.restoreVersions) return false;
      await session.flush();
      const r = await studioFetch<{ draftVersion: number }>(
        `${boot.endpoints.versions}/${versionId}/restore`,
        { method: 'POST', json: {} },
      );
      if (!r.ok) {
        toast.error(r.status === 404 ? 'Restoring is still being built.' : r.error.message);
        return false;
      }
      const draft = await studioFetch<DraftSnapshot>(boot.endpoints.draft);
      if (draft.ok) editor.reset(draft.value.doc as EventDoc, draft.value.version);
      session.syncNow();
      studio.setVersionPreview(null);
      toast.success('Restored as the draft. Publish when you are ready; nothing went live.');
      return true;
    },
    [studio],
  );
}
